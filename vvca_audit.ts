/**
 * VVCA Auditoría v3 — scrape + evaluación contextual + propuestas automáticas
 *
 * Uso:
 *   npx ts-node --esm vvca_audit.ts [--out DIR] [--contexto caso.json] REG1 REG2 ...
 *
 * Con contexto: evalúa relevancia de cada tesis al caso, descarta inaplicables
 * y busca de oficio alternativas más pertinentes en SJF.
 * Sin contexto: modo legacy — sólo score por tipo de tesis.
 */
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// ── FLAGS ─────────────────────────────────────────────────────────────────────
const outFlagIdx     = process.argv.indexOf('--out');
const ctxFlagIdx     = process.argv.indexOf('--contexto');
const DEFAULT_OUT    = 'c:\\Users\\licjo\\.itosturre\\itosturre-agente\\auditorias\\2026-06-14-FOVISSSTE';
const OUT_DIR        = outFlagIdx  !== -1 ? process.argv[outFlagIdx  + 1] : DEFAULT_OUT;
const CONTEXTO_FILE  = ctxFlagIdx  !== -1 ? process.argv[ctxFlagIdx  + 1] : null;

const SJF_SEARCH = 'https://sjf2.scjn.gob.mx/busqueda-principal-tesis';

// ── INTERFACES ────────────────────────────────────────────────────────────────
interface CasoContexto {
  expediente:        string;
  tipo:              string;           // 'familiar' | 'civil' | 'penal' | 'administrativo' | 'amparo'
  materia_principal: string;
  temas:             string[];         // palabras clave del caso
  petitorios:        string[];         // descripcion de cada petitorio
  descripcion:       string;           // resumen libre del caso
}

type EstadoAplicabilidad = 'APLICABLE' | 'PARCIAL' | 'DESCARTADO' | 'PROPUESTA';

interface TesisVVCA {
  registro:            string;
  rubro:               string;
  numero_tesis:        string;
  tipo_tesis:          string;
  sala:                string;
  epoca:               string;
  materia:             string;
  fuente:              string;
  texto_completo:      string;
  url:                 string;
  screenshot:          string;
  // Scores VVCA
  score_tipo:          number;   // basado en tipo (jurisprudencia/aislada/etc)
  score_relevancia:    number;   // basado en contenido vs caso (0 si no hay contexto)
  score_combinado:     number;   // score final para decisión
  vvca_semaforo:       string;
  vvca_observacion:    string;
  // Evaluación contextual
  estado:              EstadoAplicabilidad;
  razon_estado:        string;
  petitorio_sugerido:  string;  // qué petitorio refuerza
  forma_cita:          string;  // 'CITAR DIRECTO' | 'CITAR CON RESERVA' | 'NO CITAR'
  es_propuesta:        boolean; // true = encontrada de oficio como alternativa
  busqueda_origen?:    string;  // término de búsqueda que la encontró
}

// ── SCORING POR TIPO ──────────────────────────────────────────────────────────
function scorePorTipo(tipo: string): { score: number; semaforo: string; obs: string } {
  if (/jurisprudencia/i.test(tipo))
    return { score: 92, semaforo: '🟢', obs: 'Jurisprudencia obligatoria — citar con seguridad.' };
  if (/precedente/i.test(tipo))
    return { score: 72, semaforo: '🟡', obs: 'Precedente — peso persuasivo, no vinculante.' };
  if (/aislada/i.test(tipo))
    return { score: 60, semaforo: '🟡', obs: 'Tesis aislada — orientadora, no obligatoria.' };
  return { score: 40, semaforo: '🔴', obs: 'Tipo no identificado — verificación manual requerida.' };
}

// ── SCORING POR RELEVANCIA CONTEXTUAL ────────────────────────────────────────
const MATERIAS: Record<string, string[]> = {
  familiar:       ['familiar', 'familia', 'menor', 'custodia', 'alimentos', 'divorcio', 'patria potestad', 'convivencia'],
  civil:          ['civil', 'procedimiento civil', 'código civil', 'obligaciones'],
  penal:          ['penal', 'delito', 'acusatorio', 'imputado', 'víctima'],
  administrativo: ['administrativo', 'autoridad', 'acto administrativo', 'nulidad'],
  amparo:         ['amparo', 'quejoso', 'acto reclamado', 'inconstitucional'],
};

function calcularRelevancia(
  rubro: string, texto: string, materia: string, sala: string,
  ctx: CasoContexto
): number {
  const r   = (rubro   ?? '').toLowerCase();
  const tx  = (texto   ?? '').toLowerCase();
  const mat = (materia ?? '').toLowerCase();
  const sal = (sala    ?? '').toLowerCase();
  const corpus = `${r} ${tx} ${mat} ${sal}`;

  let score = 25;

  // Materia match
  const termsMat = MATERIAS[ctx.materia_principal] ?? [ctx.materia_principal.toLowerCase()];
  if (termsMat.some(m => mat.includes(m))) {
    score += 30;
  } else if (/común|constitucional/i.test(mat)) {
    score += 12;
  } else {
    const ajena = Object.entries(MATERIAS)
      .filter(([k]) => k !== ctx.materia_principal)
      .flatMap(([, v]) => v);
    if (ajena.some(a => mat.includes(a))) score -= 20;
  }

  // Keywords del caso en rubro (peso alto)
  let rubroHits = 0;
  for (const tema of ctx.temas) {
    const kws = tema.toLowerCase().split(/\s+/).filter(k => k.length > 3);
    if (kws.some(k => r.includes(k))) rubroHits++;
  }
  score += Math.min(28, rubroHits * 7);

  // Keywords en texto (peso medio)
  let textoHits = 0;
  for (const tema of ctx.temas) {
    const kws = tema.toLowerCase().split(/\s+/).filter(k => k.length > 3);
    if (kws.some(k => corpus.includes(k))) textoHits++;
  }
  score += Math.min(12, textoHits * 3);

  // Bonus instancia
  if (/primera sala|segunda sala|pleno/i.test(sal)) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── DECISIÓN DE APLICABILIDAD ─────────────────────────────────────────────────
function evaluarAplicabilidad(
  scoreTipo: number, scoreRel: number,
  tipo: string, materia: string, rubro: string,
  esPropuesta: boolean,
  ctx: CasoContexto | null
): { estado: EstadoAplicabilidad; razon: string; petitorio: string; forma_cita: string; combinado: number } {

  const mat = (materia ?? '').toLowerCase();
  const rub = (rubro   ?? '').toLowerCase();

  if (!ctx) {
    return {
      estado:     scoreTipo >= 85 ? 'APLICABLE' : scoreTipo >= 60 ? 'PARCIAL' : 'DESCARTADO',
      razon:      'Sin contexto — evaluacion por tipo de tesis.',
      petitorio:  '',
      forma_cita: scoreTipo >= 85 ? 'CITAR DIRECTO' : scoreTipo >= 60 ? 'CITAR CON RESERVA' : 'NO CITAR',
      combinado:  scoreTipo,
    };
  }

  const combinado = Math.round(scoreTipo * 0.45 + scoreRel * 0.55);

  let estado: EstadoAplicabilidad;
  let forma_cita: string;
  if (combinado >= 72)      { estado = esPropuesta ? 'PROPUESTA' : 'APLICABLE'; forma_cita = scoreTipo >= 85 ? 'CITAR DIRECTO' : 'CITAR CON RESERVA'; }
  else if (combinado >= 48) { estado = esPropuesta ? 'PROPUESTA' : 'PARCIAL';   forma_cita = 'CITAR CON RESERVA'; }
  else                      { estado = 'DESCARTADO';                             forma_cita = 'NO CITAR'; }

  const termsMat  = MATERIAS[ctx.materia_principal] ?? [ctx.materia_principal];
  const materiaOk = termsMat.some(m => mat.includes(m));
  const razon = [
    `tipo:${scoreTipo}`,
    `rel:${scoreRel}`,
    `comb:${combinado}`,
    materiaOk ? `materia OK (${materia})` : `materia diferente (${materia} / req:${ctx.materia_principal})`,
  ].join(' · ');

  let petitorio = '';
  if (/menor|custodia|guarda|interes superior/i.test(rub))  petitorio = 'Argumento interes superior menor';
  else if (/plazo|termino|prorroga|ampliac/i.test(rub))      petitorio = 'Petitorio de ampliacion';
  else if (/prueba|pericial|oficio|evidencia/i.test(rub))    petitorio = 'Desahogo de pruebas';
  else if (/amparo|quejoso/i.test(rub))                      petitorio = 'Referencia por analogia';

  return { estado, razon, petitorio, forma_cita, combinado };
}

// ── UTILIDADES ────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Delay aleatorio entre requests al SJF para no disparar rate-limiting / bloqueo de IP
// a media demo en vivo frente a un prospecto.
function delayAntiRateLimit(): Promise<void> {
  return sleep(500 + Math.random() * 1000);
}

// ── BÚSQUEDA DE CANDIDATOS EN SJF ─────────────────────────────────────────────
async function buscarCandidatosSJF(page: Page, termino: string, max = 6, yaVistos: Set<string> = new Set()): Promise<string[]> {
  console.log(`  [BUSQUEDA] "${termino}"`);
  try {
    await page.goto(SJF_SEARCH, { waitUntil: 'networkidle', timeout: 45000 });

    // Llenar campo de búsqueda
    const inputSel = 'input[type="text"], input[type="search"]';
    await page.waitForSelector(inputSel, { timeout: 10000 }).catch(() => null);
    const inputs = await page.$$(inputSel);
    if (inputs.length > 0) {
      await inputs[0].fill(termino);
      await inputs[0].press('Enter');
      await page.waitForTimeout(3000);
    }

    const registros = await page.evaluate((max: number) => {
      const found: string[] = [];
      const links = Array.from(document.querySelectorAll('a[href*="/detalle/tesis/"]'));
      for (const link of links) {
        const m = (link as HTMLAnchorElement).href.match(/\/detalle\/tesis\/(\d+)/);
        if (m && !found.includes(m[1])) {
          found.push(m[1]);
          if (found.length >= max * 2) break;
        }
      }
      return found;
    }, max);

    return registros.filter(r => !yaVistos.has(r)).slice(0, max);
  } catch {
    return [];
  }
}

// ── AUDITAR UN REGISTRO ───────────────────────────────────────────────────────
async function auditarRegistro(
  ctx: BrowserContext,
  registro: string,
  casoCtx: CasoContexto | null,
  esPropuesta = false,
  busquedaOrigen = ''
): Promise<TesisVVCA> {
  const url            = `https://sjf2.scjn.gob.mx/detalle/tesis/${registro}`;
  const screenshotPath = path.join(OUT_DIR, `sjf_${registro}.png`);
  const page           = await ctx.newPage();

  try {
    console.log(`  [${esPropuesta ? 'PROPUESTA' : 'AUDIT'}] ${registro} — conectando SJF...`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(
      () => document.body.innerText.includes('Registro digital:'),
      { timeout: 30000 }
    );

    const datos = await page.evaluate((reg: string) => {
      const lineas = document.body.innerText.split('\n').map((l: string) => l.trim()).filter(Boolean);
      const get = (clave: string) => {
        const i = lineas.findIndex((l: string) => new RegExp(`^${clave}\\s*:?\\s*`, 'i').test(l));
        if (i === -1) return '';
        return lineas[i].replace(new RegExp(`^${clave}\\s*:?\\s*`, 'i'), '').trim() || lineas[i + 1] || '';
      };
      const tipoIdx  = lineas.findIndex((l: string) => /^Tipo\s*:/i.test(l));
      const rubro    = tipoIdx !== -1
        ? (lineas.slice(tipoIdx + 1).find((l: string) => l === l.toUpperCase() && l.length > 20) ?? '')
        : '';
      const rubroIdx = rubro ? lineas.indexOf(rubro) : -1;
      const texto_completo = rubroIdx !== -1
        ? lineas.slice(rubroIdx + 1)
            .filter((l: string) => l.length > 15 && !/^(Tesis|Instancia|Fuente|Época|Materia|Tipo|Registro)/i.test(l))
            .join('\n\n')
        : '';
      const materia = lineas.find((l: string) => /^Materia/i.test(l))
        ?.replace(/^Materia\([^)]*\)\s*:\s*/i, '').replace(/^Materia\s*:\s*/i, '') ?? '';
      const epocaFull = lineas.find((l: string) => /época/i.test(l) && !/materia|instancia/i.test(l)) ?? '';
      return {
        registro: reg, rubro,
        numero_tesis: lineas.find((l: string) => /^Tesis\s*:/i.test(l))?.replace(/^Tesis\s*:\s*/i,'') ?? '',
        tipo_tesis: get('Tipo'),
        sala: get('Instancia'), epoca: epocaFull.replace(/\s*".*"$/,'').trim(),
        materia, fuente: get('Fuente'), texto_completo,
      };
    }, registro);

    await page.addStyleTag({ content: '.alert,[class*="alert"],.cookie-banner{display:none!important}' });
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const { score: score_tipo, semaforo, obs } = scorePorTipo(datos.tipo_tesis ?? '');
    const score_relevancia = casoCtx
      ? calcularRelevancia(datos.rubro ?? '', datos.texto_completo ?? '', datos.materia ?? '', datos.sala ?? '', casoCtx)
      : 0;
    const { estado, razon, petitorio, forma_cita, combinado } = evaluarAplicabilidad(
      score_tipo, score_relevancia,
      datos.tipo_tesis ?? '', datos.materia ?? '', datos.rubro ?? '',
      esPropuesta, casoCtx
    );

    console.log(`  [${estado}] ${registro} — tipo:${score_tipo} rel:${score_relevancia} comb:${combinado} (${datos.tipo_tesis}) — ${datos.materia}`);

    // El semáforo visual debe reflejar la decisión final (estado), no solo el tipo de
    // tesis: con contexto, una tesis puede tener score_tipo alto (jurisprudencia) pero
    // quedar DESCARTADA por baja relevancia al caso — el emoji no puede contradecir eso.
    const semaforoFinal = estado === 'DESCARTADO' ? '🔴' : estado === 'PARCIAL' ? '🟡' : '🟢';

    return {
      ...datos, url, screenshot: screenshotPath,
      score_tipo, score_relevancia, score_combinado: combinado,
      vvca_semaforo: semaforoFinal, vvca_observacion: obs,
      estado, razon_estado: razon,
      petitorio_sugerido: petitorio, forma_cita,
      es_propuesta: esPropuesta, busqueda_origen: busquedaOrigen || undefined,
    };
  } catch (err) {
    console.error(`  [ERROR] ${registro}:`, (err as Error).message);
    return {
      registro, rubro: 'ERROR — no se pudo conectar al SJF', numero_tesis: '', tipo_tesis: '',
      sala: '', epoca: '', materia: '', fuente: '', texto_completo: '',
      url, screenshot: '',
      score_tipo: 0, score_relevancia: 0, score_combinado: 0,
      vvca_semaforo: '🔴', vvca_observacion: 'Error de conexión al SJF.',
      estado: 'DESCARTADO', razon_estado: 'Error al conectar con SJF.',
      petitorio_sugerido: '', forma_cita: 'NO CITAR',
      es_propuesta: esPropuesta, busqueda_origen: busquedaOrigen || undefined,
    };
  } finally {
    await page.close();
  }
}

// ── CONSTRUIR TÉRMINOS DE BÚSQUEDA ALTERNATIVOS ───────────────────────────────
function terminesBusquedaAlternativos(casoCtx: CasoContexto, descartadas: TesisVVCA[]): string[] {
  // Términos del caso ordenados por prioridad
  const base = casoCtx.temas.map(t => `${t} ${casoCtx.materia_principal}`);
  // Términos de los petitorios
  const dePetitorios = casoCtx.petitorios.map(p => p);
  // Términos genéricos por materia
  const genericos: Record<string, string[]> = {
    familiar: ['interes superior menor familiar', 'prueba familiar derecho menor', 'facultad juzgador familiar'],
    civil:    ['plazo proceso civil', 'derecho prueba civil', 'termino procesal civil'],
    penal:    ['derecho defensa penal', 'prueba penal acusatorio'],
    administrativo: ['plazo administrativo nulidad', 'derecho audiencia administrativo'],
  };
  const gen = genericos[casoCtx.materia_principal] ?? [];

  // Deduplicar y limitar
  return [...new Set([...base, ...dePetitorios, ...gen])].slice(0, 6);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  // Filtrar flags de los registros
  const skipArgs = new Set<string>();
  if (outFlagIdx !== -1) { skipArgs.add('--out');       skipArgs.add(process.argv[outFlagIdx  + 1]); }
  if (ctxFlagIdx !== -1) { skipArgs.add('--contexto'); skipArgs.add(process.argv[ctxFlagIdx + 1]); }
  const registros = process.argv.slice(2).filter(a => !skipArgs.has(a) && !a.startsWith('--'));

  if (!registros.length) {
    console.error('Uso: npx ts-node --esm vvca_audit.ts [--out DIR] [--contexto caso.json] REG1 REG2 ...');
    process.exit(1);
  }

  // Cargar contexto de caso (opcional)
  let casoCtx: CasoContexto | null = null;
  if (CONTEXTO_FILE && fs.existsSync(CONTEXTO_FILE)) {
    casoCtx = JSON.parse(fs.readFileSync(CONTEXTO_FILE, 'utf-8')) as CasoContexto;
    console.log(`\n[CONTEXTO] ${casoCtx.expediente} — ${casoCtx.tipo} · ${casoCtx.materia_principal}`);
  }

  console.log(`\n[VVCA v3] ${registros.length} registro(s) · SJF en tiempo real · OUT: ${OUT_DIR}`);
  if (casoCtx) console.log(`[MODO] Evaluacion contextual ACTIVA — busqueda automatica de alternativas habilitada\n`);
  else         console.log(`[MODO] Sin contexto — scoring por tipo de tesis\n`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu'] });

  // Declarados fuera del try para seguir disponibles en la salida JSON/reporte
  // aunque algo falle a media ejecución (se guarda lo que se haya alcanzado a auditar).
  const verificados: TesisVVCA[] = [];
  const propuestas: TesisVVCA[] = [];

  try {
    const ctx = await browser.newContext({
      viewport:  { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    });

    // ── FASE 1: Auditar registros originales ──────────────────────────────────
    console.log('── FASE 1: Verificacion de registros ──');
    for (const reg of registros) {
      verificados.push(await auditarRegistro(ctx, reg, casoCtx, false, ''));
      await delayAntiRateLimit();
    }

    // ── FASE 2: Buscar alternativas para descartados (sólo con contexto) ──────
    const yaVistos = new Set(registros);

    if (casoCtx) {
      const descartados = verificados.filter(t => t.estado === 'DESCARTADO');
      if (descartados.length > 0) {
        console.log(`\n── FASE 2: Busqueda automatica de alternativas (${descartados.length} descartado(s)) ──`);
        const searchPage = await ctx.newPage();
        try {
          const terminos = terminesBusquedaAlternativos(casoCtx, descartados);

          for (const termino of terminos) {
            const candidatos = await buscarCandidatosSJF(searchPage, termino, 4, yaVistos);
            await delayAntiRateLimit();
            for (const reg of candidatos) {
              yaVistos.add(reg);
              const tesis = await auditarRegistro(ctx, reg, casoCtx, true, termino);
              await delayAntiRateLimit();
              if (tesis.estado !== 'DESCARTADO') {
                propuestas.push(tesis);
                console.log(`  [+] Propuesta aceptada: ${reg} (score_comb: ${tesis.score_combinado})`);
              }
              if (propuestas.length >= 5) break;
            }
            if (propuestas.length >= 5) break;
          }
        } finally {
          await searchPage.close();
        }
      } else {
        console.log('\n[OK] Todos los registros son aplicables — no se requieren alternativas.');
      }
    }
  } finally {
    await browser.close();
  }

  // ── SALIDA JSON ───────────────────────────────────────────────────────────
  const salida = { verificados, propuestas };
  const jsonPath = path.join(OUT_DIR, 'auditoria_vvca.json');
  fs.writeFileSync(jsonPath, JSON.stringify(salida, null, 2), 'utf-8');

  // ── REPORTE CONSOLA ───────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════');
  console.log('  RESULTADO AUDITORIA VVCA v3');
  console.log('════════════════════════════════════════════════════\n');

  for (const t of [...verificados, ...propuestas]) {
    const tag = t.es_propuesta ? '[PROPUESTA]' : '[ORIGINAL ]';
    console.log(`${t.vvca_semaforo} ${tag} ${t.registro} — comb:${t.score_combinado} (tipo:${t.score_tipo} rel:${t.score_relevancia}) — ${t.estado}`);
    console.log(`   Numero:    ${t.numero_tesis}`);
    console.log(`   Tipo:      ${t.tipo_tesis}`);
    console.log(`   Instancia: ${t.sala}`);
    console.log(`   Materia:   ${t.materia}`);
    console.log(`   Rubro:     ${t.rubro.slice(0, 110)}`);
    console.log(`   Estado:    ${t.estado} — ${t.razon_estado}`);
    console.log(`   Cita:      ${t.forma_cita}`);
    if (t.es_propuesta) console.log(`   Origen:    Busqueda "${t.busqueda_origen}"`);
    console.log();
  }

  const aplicables  = [...verificados, ...propuestas].filter(t => t.estado !== 'DESCARTADO');
  const descartados = verificados.filter(t => t.estado === 'DESCARTADO');
  console.log(`Verificados: ${verificados.length} | Aplicables: ${aplicables.length} | Descartados: ${descartados.length} | Propuestas: ${propuestas.length}`);
  console.log(`JSON: ${jsonPath}`);
}

main();
