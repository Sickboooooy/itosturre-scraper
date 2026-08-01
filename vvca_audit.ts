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
import { pathToFileURL, fileURLToPath } from 'url';
import {
  SJF_PORTALS,
  aggregateFailureStatus,
  buildDetailUrl,
  buildSearchUrl,
  classifySjfFailure,
  type SjfAttemptTrace,
  type SjfPortal,
} from './sjf_resilience.ts';

// ── VIGENCIA DE TESIS (falso verde) ────────────────────────────────────────────
// Detecta si el criterio de una tesis fue superado/interrumpido/sustituido a partir de la
// sección NOTAS/EJECUTORIAS del detalle SJF. El campo resultante `estado_vigencia` viaja al
// corpus local jurisprudencia/*.json, donde OpenNotebook.build_vvca_tesis lo lee y
// scoring_vvca.veredicto_global lo convierte en 🔴 bloqueante (parámetro tesis_superadas).
//
// PRECISIÓN > cobertura (a propósito): patrones AFIRMATIVOS ("fue/quedó/se + superada…") + guardia
// de negación. Ante la duda ⇒ 'vigente'. Un falso positivo bloquearía una tesis válida (peor que
// no proteger). Pruebas en vigencia.test.ts (npx ts-node compila → node).
export type EstadoVigencia = 'vigente' | 'superada' | 'interrumpida' | 'sustituida';

const VIGENCIA_PATRONES: Array<[EstadoVigencia, RegExp]> = [
  [
    'superada',
    /\b(?:fue|ha\s+sido|qued[oó]|result[oó]|se)\s+superad\w*|dej[oó]\s+de\s+(?:tener|considerarse|ser)\b[^.]{0,60}(?:jurisprudencia|aplicaci[oó]n\s+obligatoria|obligatori\w*|aplicable)|ya\s+no\s+(?:resulta|es|se\s+considera)\b[^.]{0,40}(?:aplicable|obligatori\w*)/i,
  ],
  ['interrumpida', /\b(?:fue|ha\s+sido|qued[oó]|se)\s+interrump[a-záéíóú]*|interrump[a-záéíóú]*\s+(?:el|la|dicho|dicha)\s+(?:criterio|jurisprudencia|tesis)/i],
  ['sustituida', /\b(?:fue|ha\s+sido|qued[oó]|se)\s+sustitu[a-záéíóú]*|sustituy[a-záéíóú]*\s+(?:por|la\s+(?:presente|diversa|tesis))/i],
];

const VIGENCIA_NEGACION = /(desechad|negad|improcedente|sin\s+materia|se\s+mantiene|subsiste|(?:contin[uú]a|sigue)\s+(?:firme|vigente|aplicable))/i;

/** Detecta el estado de vigencia desde el texto de la sección NOTAS. Vacío ⇒ 'vigente'. */
export function detectarVigencia(notas: string): { estado_vigencia: EstadoVigencia; notas_vigencia: string } {
  const scan = (notas || '').trim();
  if (!scan) return { estado_vigencia: 'vigente', notas_vigencia: '' };
  for (const [estado, re] of VIGENCIA_PATRONES) {
    const m = scan.match(re);
    if (!m) continue;
    const idx = m.index ?? 0;
    const ventana = scan.slice(Math.max(0, idx - 60), idx + 160);
    if (VIGENCIA_NEGACION.test(ventana)) continue; // desestimada → no pierde vigencia
    return { estado_vigencia: estado, notas_vigencia: ventana.replace(/\s+/g, ' ').trim() };
  }
  return { estado_vigencia: 'vigente', notas_vigencia: '' };
}

// ── FLAGS ─────────────────────────────────────────────────────────────────────
const outFlagIdx     = process.argv.indexOf('--out');
const ctxFlagIdx     = process.argv.indexOf('--contexto');
const DEFAULT_OUT    = 'c:\\Users\\licjo\\.itosturre\\itosturre-agente\\auditorias\\2026-06-14-FOVISSSTE';
const OUT_DIR        = outFlagIdx  !== -1 ? process.argv[outFlagIdx  + 1] : DEFAULT_OUT;
const CONTEXTO_FILE  = ctxFlagIdx  !== -1 ? process.argv[ctxFlagIdx  + 1] : null;

// ── CACHÉ / RESILIENCIA ────────────────────────────────────────────────────────
// El scraper del SJF es el punto único de falla del foso VVCA. Caché por registro (los datos
// de una tesis publicada no cambian salvo su vigencia) + reintentos + detección de cambio de
// layout. `--no-cache` fuerza SJF en vivo; `--cache-ttl-dias N` ajusta la frescura (default 30).
const SCRIPT_DIR      = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR       = path.join(SCRIPT_DIR, '.sjf_cache');
const USAR_CACHE      = !process.argv.includes('--no-cache');
const ttlFlagIdx      = process.argv.indexOf('--cache-ttl-dias');
const CACHE_TTL_DIAS  = ttlFlagIdx !== -1 ? (Number(process.argv[ttlFlagIdx + 1]) || 30) : 30;
// Los DATOS de una tesis publicada no cambian, pero su VIGENCIA sí puede perderse en cualquier
// momento (superación/interrupción). Ventana corta para confiar en un 'vigente' cacheado; más
// allá, se avisa que para uso procesal final conviene re-verificar en vivo (--no-cache).
const VIGENCIA_FRESCURA_DIAS = 7;

// Datos crudos extraídos del detalle SJF (lo que se cachea; scoring y vigencia se recomputan).
interface DatosSJF {
  registro: string; rubro: string; numero_tesis: string; tipo_tesis: string;
  sala: string; epoca: string; materia: string; fuente: string;
  texto_completo: string; notas_raw: string;
  origen_url?: string; capturado_en?: string;
}

type ScrapeFallbackResult =
  | { ok: true; datos: DatosSJF; portal: SjfPortal; url: string; attempts: SjfAttemptTrace[] }
  | { ok: false; url: string; attempts: SjfAttemptTrace[] };

function leerCacheDatos(reg: string): DatosSJF | null {
  try {
    const f = path.join(CACHE_DIR, `${reg}.json`);
    if (!fs.existsSync(f)) return null;
    const edadDias = (Date.now() - fs.statSync(f).mtimeMs) / 86_400_000;
    if (edadDias > CACHE_TTL_DIAS) return null; // caché vencida → re-scrapear
    return JSON.parse(fs.readFileSync(f, 'utf-8')) as DatosSJF;
  } catch { return null; }
}

function edadCacheDias(reg: string): number {
  try {
    const f = path.join(CACHE_DIR, `${reg}.json`);
    if (!fs.existsSync(f)) return -1;
    return (Date.now() - fs.statSync(f).mtimeMs) / 86_400_000;
  } catch { return -1; }
}

function escribirCacheDatos(reg: string, datos: DatosSJF): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${reg}.json`), JSON.stringify(datos, null, 2), 'utf-8');
  } catch { /* caché best-effort — nunca aborta la auditoría */ }
}

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
type EstadoConsultaSJF = 'VERIFICADO' | 'NO_ENCONTRADO' | 'NO_VERIFICABLE' | 'LAYOUT_INCOMPATIBLE';

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
  // Vigencia del criterio (falso verde) — parseada de la sección NOTAS del SJF
  estado_vigencia:     EstadoVigencia; // 'vigente' | 'superada' | 'interrumpida' | 'sustituida'
  notas_vigencia:      string;         // fragmento que lo justifica ('' si vigente)
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
  estado_consulta:     EstadoConsultaSJF;
  origen_consulta:     'cache' | 'sjf2' | 'sjfsemanal' | 'ninguno';
  consultado_en:       string;
  trazabilidad_consulta: {
    schema_version: '1.0';
    attempts: SjfAttemptTrace[];
  };
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
  const termsMat = MATERIAS[ctx.materia_principal] ?? [(ctx.materia_principal ?? '').toLowerCase()].filter(Boolean);
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
async function buscarCandidatosSJF(
  page: Page, termino: string, max = 6, yaVistos: Set<string> = new Set(),
): Promise<{ registros: string[]; traces: SjfAttemptTrace[] }> {
  console.log(`  [BUSQUEDA] "${termino}"`);
  const traces: SjfAttemptTrace[] = [];
  for (const portal of SJF_PORTALS) {
    const url = buildSearchUrl(portal);
    const started = new Date().toISOString();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (response?.status() === 403) throw new Error('SJF_ACCESS_BLOCKED: HTTP 403');
      if (response?.status() === 404) throw new Error('SJF_NOT_FOUND: HTTP 404');
      await page.waitForTimeout(2500);

      const inputSel = 'input[type="text"], input[type="search"]';
      const inputs = await page.$$(inputSel);
      if (inputs.length === 0) throw new Error('SJF_LAYOUT_CHANGED: selector de búsqueda ausente');
      await inputs[0].fill(termino);
      await inputs[0].press('Enter');
      await page.waitForTimeout(3000);

      const registros = await page.evaluate((limit: number) => {
        const found: string[] = [];
        const links = Array.from(document.querySelectorAll('a[href*="/detalle/tesis/"]'));
        for (const link of links) {
          const m = (link as HTMLAnchorElement).href.match(/\/detalle\/tesis\/(\d+)/);
          if (m && !found.includes(m[1])) {
            found.push(m[1]);
            if (found.length >= limit * 2) break;
          }
        }
        return found;
      }, max);

      traces.push({
        portal: portal.id, url, attempt: 1, started_at: started,
        finished_at: new Date().toISOString(), status: 'SUCCESS',
        message: registros.length ? `${registros.length} resultado(s)` : '0 resultados',
      });
      return { registros: registros.filter(r => !yaVistos.has(r)).slice(0, max), traces };
    } catch (error) {
      const failure = classifySjfFailure(error);
      traces.push({
        portal: portal.id, url, attempt: 1, started_at: started,
        finished_at: new Date().toISOString(), status: 'FAILED',
        failure_class: failure,
        message: (error as Error).message.slice(0, 240),
      });
      console.warn(`  [FALLBACK] búsqueda en ${portal.id}: ${failure}`);
    }
  }
  return { registros: [], traces };
}

// ── AUDITAR UN REGISTRO ───────────────────────────────────────────────────────
function tesisError(
  registro: string, url: string, esPropuesta: boolean, busquedaOrigen: string,
  attempts: SjfAttemptTrace[],
): TesisVVCA {
  const estadoConsulta = aggregateFailureStatus(attempts);
  const ausenciaConfirmada = estadoConsulta === 'NO_ENCONTRADO';
  return {
    registro,
    rubro: ausenciaConfirmada ? 'NO ENCONTRADA EN LOS PORTALES SJF' : 'NO VERIFICABLE — consulta SJF fallida',
    numero_tesis: '', tipo_tesis: '',
    sala: '', epoca: '', materia: '', fuente: '', texto_completo: '',
    estado_vigencia: 'vigente', notas_vigencia: '',
    url, screenshot: '',
    score_tipo: 0, score_relevancia: 0, score_combinado: 0,
    vvca_semaforo: ausenciaConfirmada ? '🔴' : '🟡',
    vvca_observacion: ausenciaConfirmada
      ? 'Registro no encontrado tras consultar ambos portales públicos.'
      : 'No verificable por fallo técnico; no equivale a cita falsa.',
    estado: 'DESCARTADO',
    razon_estado: ausenciaConfirmada
      ? 'Ausencia confirmada en ambos portales públicos del SJF.'
      : `Consulta no concluyente (${estadoConsulta}); verificar manualmente.`,
    petitorio_sugerido: '', forma_cita: 'NO CITAR',
    es_propuesta: esPropuesta, busqueda_origen: busquedaOrigen || undefined,
    estado_consulta: estadoConsulta,
    origen_consulta: 'ninguno',
    consultado_en: new Date().toISOString(),
    trazabilidad_consulta: { schema_version: '1.0', attempts },
  };
}

// Una navegación al detalle SJF → datos crudos + screenshot (requiere la página viva).
async function extraerDatosSJF(page: Page, registro: string, url: string, screenshotPath: string): Promise<DatosSJF> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (response?.status() === 403) throw new Error('SJF_ACCESS_BLOCKED: HTTP 403');
  if (response?.status() === 404) throw new Error('SJF_NOT_FOUND: HTTP 404');
  await page.waitForTimeout(2500);
  const bodyText = await page.locator('body').innerText({ timeout: 10000 });
  if (/acceso denegado|access denied|forbidden/i.test(bodyText)) {
    throw new Error('SJF_ACCESS_BLOCKED: respuesta de acceso denegado');
  }
  if (/tesis no encontrada|registro no encontrado|sin resultados/i.test(bodyText)) {
    throw new Error('SJF_NOT_FOUND: el portal no encontró el registro');
  }
  if (!bodyText.includes('Registro digital:')) {
    throw new Error('SJF_LAYOUT_CHANGED: marcador Registro digital ausente');
  }
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

      // Sección NOTAS/EJECUTORIAS (donde el SJF publica la pérdida de vigencia). Se corta al
      // llegar al pie institucional. Si no hay sección rotulada, se rescatan líneas
      // auto-referenciales "Esta tesis fue …" para casos de nota embebida en el cuerpo.
      const esPie = (l: string) => /(suprema corte de justicia de la naci|cont[aá]ctanos|redes sociales|ubicaci[oó]n|derechos reservados|©|pino su[aá]rez)/i.test(l);
      let notas_raw = '';
      const notaIdx = lineas.findIndex((l: string) => /^(notas?|ejecutorias?)\b/i.test(l));
      if (notaIdx !== -1) {
        let end = lineas.length;
        for (let j = notaIdx + 1; j < lineas.length; j++) { if (esPie(lineas[j])) { end = j; break; } }
        notas_raw = lineas.slice(notaIdx, end).join('\n').slice(0, 3000);
      } else {
        notas_raw = lineas
          .filter((l: string) => /(esta tesis|la presente tesis|este criterio|dicha tesis|dicho criterio)\s+(fue|ha sido|qued[oó]|dej[oó]|ya no)/i.test(l))
          .join('\n')
          .slice(0, 2000);
      }

      return {
        registro: reg, rubro,
        numero_tesis: lineas.find((l: string) => /^Tesis\s*:/i.test(l))?.replace(/^Tesis\s*:\s*/i,'') ?? '',
        tipo_tesis: get('Tipo'),
        sala: get('Instancia'), epoca: epocaFull.replace(/\s*".*"$/,'').trim(),
        materia, fuente: get('Fuente'), texto_completo, notas_raw,
      };
    }, registro) as DatosSJF;

  await page.addStyleTag({ content: '.alert,[class*="alert"],.cookie-banner{display:none!important}' });
  await page.screenshot({ path: screenshotPath, fullPage: false });
  return { ...datos, origen_url: url, capturado_en: new Date().toISOString() };
}

// Reintenta cada portal público y cae de sjf2 a sjfsemanal sin ocultar el motivo del fallo.
async function scrapearConFallback(
  ctx: BrowserContext, registro: string, screenshotPath: string, intentos = 2,
): Promise<ScrapeFallbackResult> {
  const attempts: SjfAttemptTrace[] = [];
  for (const portal of SJF_PORTALS) {
    const url = buildDetailUrl(portal, registro);
    for (let attempt = 1; attempt <= intentos; attempt++) {
      const page = await ctx.newPage();
      const started = new Date().toISOString();
      try {
        const datos = await extraerDatosSJF(page, registro, url, screenshotPath);
        attempts.push({
          portal: portal.id, url, attempt, started_at: started,
          finished_at: new Date().toISOString(), status: 'SUCCESS',
        });
        return { ok: true, datos, portal, url, attempts };
      } catch (error) {
        const failure = classifySjfFailure(error);
        attempts.push({
          portal: portal.id, url, attempt, started_at: started,
          finished_at: new Date().toISOString(), status: 'FAILED',
          failure_class: failure,
          message: (error as Error).message.slice(0, 240),
        });
        console.warn(`  [${portal.id} ${attempt}/${intentos}] ${registro} — ${failure}`);
        if (failure === 'NOT_FOUND') break;
        if (attempt < intentos) await sleep(1500 * attempt);
      } finally {
        await page.close();
      }
    }
    console.warn(`  [FALLBACK] ${registro} — cambiando de ${portal.id} al siguiente portal público.`);
  }
  return { ok: false, url: buildDetailUrl(SJF_PORTALS[0], registro), attempts };
}

async function auditarRegistro(
  ctx: BrowserContext,
  registro: string,
  casoCtx: CasoContexto | null,
  esPropuesta = false,
  busquedaOrigen = ''
): Promise<TesisVVCA> {
  let url              = buildDetailUrl(SJF_PORTALS[0], registro);
  const screenshotPath = path.join(OUT_DIR, `sjf_${registro}.png`);
  let attempts: SjfAttemptTrace[] = [];
  let origenConsulta: TesisVVCA['origen_consulta'] = 'ninguno';
  let consultadoEn = new Date().toISOString();

  // 1) Caché por registro (resiliencia + no martillar el SJF).
  const cacheEdadDias = USAR_CACHE ? edadCacheDias(registro) : -1;
  let datos: DatosSJF | null = USAR_CACHE ? leerCacheDatos(registro) : null;
  const desdeCache = !!datos;
  if (datos) {
    console.log(`  [CACHE] ${registro} — copia local (sin tocar el SJF).`);
    url = datos.origen_url || url;
    consultadoEn = datos.capturado_en || consultadoEn;
    origenConsulta = 'cache';
    attempts = [{
      portal: 'cache', url, attempt: 1,
      started_at: consultadoEn, finished_at: consultadoEn, status: 'CACHE_HIT',
    }];
  } else {
    console.log(`  [${esPropuesta ? 'PROPUESTA' : 'AUDIT'}] ${registro} — conectando SJF...`);
    const scrape = await scrapearConFallback(ctx, registro, screenshotPath);
    attempts = scrape.attempts;
    if (!scrape.ok) {
      console.error(`  [ERROR] ${registro}: ${aggregateFailureStatus(attempts)}`);
      return tesisError(registro, scrape.url, esPropuesta, busquedaOrigen, attempts);
    }
    datos = scrape.datos;
    url = scrape.url;
    origenConsulta = scrape.portal.id;
    consultadoEn = datos.capturado_en || new Date().toISOString();
    // 2) Detección de cambio de layout: campos clave vacíos ⇒ el DOM del SJF pudo cambiar.
    if (!datos.rubro && !datos.numero_tesis) {
      console.warn(`  [LAYOUT?] ${registro} — rubro y número vacíos; posible cambio de estructura del SJF (no se cachea).`);
      attempts.push({
        portal: scrape.portal.id, url, attempt: 1,
        started_at: consultadoEn, finished_at: new Date().toISOString(), status: 'FAILED',
        failure_class: 'LAYOUT_CHANGED', message: 'Rubro y número de tesis vacíos',
      });
      return tesisError(registro, url, esPropuesta, busquedaOrigen, attempts);
    } else {
      escribirCacheDatos(registro, datos);
    }
  }

  // 3) Vigencia + scoring (idéntico venga de caché o de SJF en vivo).
  const { notas_raw, ...datosBase } = datos as DatosSJF;
  const { estado_vigencia, notas_vigencia } = detectarVigencia(notas_raw ?? '');
  if (estado_vigencia !== 'vigente') {
    console.log(`  [VIGENCIA] ${registro} — criterio ${estado_vigencia.toUpperCase()}: ${notas_vigencia.slice(0, 90)}`);
  } else if (desdeCache && cacheEdadDias > VIGENCIA_FRESCURA_DIAS) {
    // Falso verde por caché añeja: el 'vigente' es de hace días; la tesis pudo ser superada
    // después. No cambia el veredicto (los datos son estables), pero se avisa el riesgo temporal.
    console.warn(`  [VIGENCIA?] ${registro} — 'vigente' proviene de caché de hace ${Math.round(cacheEdadDias)}d; una tesis puede ser superada después. Para uso procesal final, re-verifica en vivo (--no-cache).`);
  }

  const { score: score_tipo, obs } = scorePorTipo(datosBase.tipo_tesis ?? '');
  const score_relevancia = casoCtx
    ? calcularRelevancia(datosBase.rubro ?? '', datosBase.texto_completo ?? '', datosBase.materia ?? '', datosBase.sala ?? '', casoCtx)
    : 0;
  const { estado, razon, petitorio, forma_cita, combinado } = evaluarAplicabilidad(
    score_tipo, score_relevancia,
    datosBase.tipo_tesis ?? '', datosBase.materia ?? '', datosBase.rubro ?? '',
    esPropuesta, casoCtx
  );

  console.log(`  [${estado}] ${registro} — tipo:${score_tipo} rel:${score_relevancia} comb:${combinado} (${datosBase.tipo_tesis}) — ${datosBase.materia}`);

  // El semáforo visual refleja la decisión final (estado), no solo el tipo de tesis.
  const semaforoFinal = estado === 'DESCARTADO' ? '🔴' : estado === 'PARCIAL' ? '🟡' : '🟢';

  return {
    ...datosBase, estado_vigencia, notas_vigencia, url,
    screenshot: fs.existsSync(screenshotPath) ? screenshotPath : '',
    score_tipo, score_relevancia, score_combinado: combinado,
    vvca_semaforo: semaforoFinal, vvca_observacion: obs,
    estado, razon_estado: razon,
    petitorio_sugerido: petitorio, forma_cita,
    es_propuesta: esPropuesta, busqueda_origen: busquedaOrigen || undefined,
    estado_consulta: 'VERIFICADO',
    origen_consulta: origenConsulta,
    consultado_en: consultadoEn,
    trazabilidad_consulta: { schema_version: '1.0', attempts },
  };
}

// ── CONSTRUIR TÉRMINOS DE BÚSQUEDA ALTERNATIVOS ───────────────────────────────
function terminesBusquedaAlternativos(casoCtx: CasoContexto, descartadas: TesisVVCA[]): string[] {
  // Términos del caso ordenados por prioridad
  const base = (casoCtx.temas ?? []).map(t => `${t} ${casoCtx.materia_principal ?? ''}`);
  // Términos de los petitorios
  const dePetitorios = (casoCtx.petitorios ?? []).map(p => p);
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
  const trazasBusqueda: SjfAttemptTrace[] = [];

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
            const busqueda = await buscarCandidatosSJF(searchPage, termino, 4, yaVistos);
            trazasBusqueda.push(...busqueda.traces);
            await delayAntiRateLimit();
            for (const reg of busqueda.registros) {
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
  const salida = {
    schema_version: '2.0',
    generado_en: new Date().toISOString(),
    politica_fuentes: {
      portales_publicos: SJF_PORTALS.map(p => p.baseUrl),
      api_interna: 'NO_CONSUMIDA',
      razon: 'Contrato técnico no documentado públicamente; se usan únicamente interfaces públicas.',
    },
    verificados,
    propuestas,
    consultas_busqueda: trazasBusqueda,
  };
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
    console.log(`   Consulta:  ${t.estado_consulta} vía ${t.origen_consulta}`);
    console.log(`   Cita:      ${t.forma_cita}`);
    if (t.es_propuesta) console.log(`   Origen:    Busqueda "${t.busqueda_origen}"`);
    console.log();
  }

  const aplicables  = [...verificados, ...propuestas].filter(t => t.estado !== 'DESCARTADO');
  const descartados = verificados.filter(t => t.estado === 'DESCARTADO');
  console.log(`Verificados: ${verificados.length} | Aplicables: ${aplicables.length} | Descartados: ${descartados.length} | Propuestas: ${propuestas.length}`);
  console.log(`JSON: ${jsonPath}`);
}

// Ejecuta main() solo cuando el archivo es el punto de entrada (no al importarlo desde
// vigencia.test.ts, que reutiliza detectarVigencia sin arrancar el scraper).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
