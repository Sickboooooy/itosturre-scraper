/**
 * VVCA Auditoría — scrape + screenshot en una sola corrida
 * Uso: npx ts-node --esm vvca_audit.ts 2030407 2029965
 */
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = 'c:\\Users\\licjo\\.itosturre\\itosturre-agente\\auditorias\\2026-06-14-FOVISSSTE';

interface TesisVVCA {
  registro: string;
  rubro: string;
  numero_tesis: string;
  tipo_tesis: string;
  sala: string;
  epoca: string;
  materia: string;
  fuente: string;
  texto_completo: string;
  vvca_semaforo: string;
  vvca_score: number;
  vvca_observacion: string;
  url: string;
  screenshot: string;
}

function calcularScore(tipo: string): { score: number; semaforo: string; obs: string } {
  if (/jurisprudencia/i.test(tipo)) return { score: 92, semaforo: '🟢', obs: 'Jurisprudencia obligatoria — citar con seguridad' };
  if (/aislada/i.test(tipo))       return { score: 65, semaforo: '🟡', obs: 'Tesis aislada — orientadora, no obligatoria. Evaluar sustituir por jurisprudencia.' };
  if (/precedente/i.test(tipo))    return { score: 70, semaforo: '🟡', obs: 'Precedente — peso persuasivo, no vinculante.' };
  return { score: 50, semaforo: '🔴', obs: 'Tipo de tesis no identificado — verificación manual requerida.' };
}

async function auditarRegistro(ctx: BrowserContext, registro: string): Promise<TesisVVCA> {
  const url = `https://sjf2.scjn.gob.mx/detalle/tesis/${registro}`;
  const screenshotPath = path.join(OUT_DIR, `sjf_${registro}.png`);
  const page = await ctx.newPage();

  try {
    console.log(`  🔍 [${registro}] Conectando a SJF...`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(
      () => document.body.innerText.includes('Registro digital:'),
      { timeout: 30000 }
    );
    console.log(`  ✅ [${registro}] Página cargada — extrayendo datos...`);

    const datos = await page.evaluate((reg) => {
      const lineas = document.body.innerText
        .split('\n').map((l: string) => l.trim()).filter(Boolean);

      const getValor = (clave: string): string => {
        const idx = lineas.findIndex((l: string) => new RegExp(`^${clave}\\s*:?\\s*`, 'i').test(l));
        if (idx === -1) return '';
        const val = lineas[idx].replace(new RegExp(`^${clave}\\s*:?\\s*`, 'i'), '').trim();
        return val || lineas[idx + 1] || '';
      };

      const tipoIdx = lineas.findIndex((l: string) => /^Tipo\s*:/i.test(l));
      const rubro = tipoIdx !== -1
        ? (lineas.slice(tipoIdx + 1).find((l: string) => l === l.toUpperCase() && l.length > 20) ?? '')
        : '';

      const rubroIdx = rubro ? lineas.indexOf(rubro) : -1;
      const texto_completo = rubroIdx !== -1
        ? lineas.slice(rubroIdx + 1)
            .filter((l: string) => l.length > 15 && !/^(Tesis|Instancia|Fuente|Época|Materia|Tipo|Registro)/i.test(l))
            .join('\n\n')
        : '';

      const numero_tesis = lineas.find((l: string) => /^Tesis\s*:/i.test(l))
        ?.replace(/^Tesis\s*:\s*/i, '') ?? '';
      const materia = lineas.find((l: string) => /^Materia/i.test(l))
        ?.replace(/^Materia\([^)]*\)\s*:\s*/i, '').replace(/^Materia\s*:\s*/i, '') ?? '';
      const epocaFull = lineas.find((l: string) => /época/i.test(l) && !/materia/i.test(l) && !/instancia/i.test(l)) ?? '';
      const epoca = epocaFull.replace(/\s*".*"$/, '').trim();
      const tipo_tesis = getValor('Tipo');

      return { registro: reg, rubro, numero_tesis, tipo_tesis,
               sala: getValor('Instancia'), epoca, materia,
               fuente: getValor('Fuente'), texto_completo };
    }, registro);

    // Screenshot limpio para el PDF de auditoría
    await page.addStyleTag({ content: '.alert, .alert-warning, [class*="alert"], .cookie-banner { display: none !important; }' });
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`  📸 [${registro}] Screenshot guardado: ${screenshotPath}`);

    const { score, semaforo, obs } = calcularScore(datos.tipo_tesis);

    return {
      ...datos,
      vvca_semaforo: semaforo,
      vvca_score: score,
      vvca_observacion: obs,
      url,
      screenshot: screenshotPath,
    };
  } catch (err) {
    console.error(`  ❌ [${registro}] Error:`, (err as Error).message);
    return {
      registro, rubro: 'ERROR — No se pudo conectar al SJF', numero_tesis: '', tipo_tesis: '',
      sala: '', epoca: '', materia: '', fuente: '', texto_completo: '',
      vvca_semaforo: '🔴', vvca_score: 0,
      vvca_observacion: 'Error de conexión al SJF — verificar manualmente.',
      url, screenshot: '',
    };
  } finally {
    await page.close();
  }
}

async function main() {
  const registros = process.argv.slice(2);
  if (!registros.length) {
    console.error('Uso: npx ts-node --esm vvca_audit.ts REG1 REG2 ...');
    process.exit(1);
  }

  console.log(`\n🔬 AUDITORÍA VVCA — ${registros.length} criterio(s) · SJF en tiempo real`);
  console.log(`📁 Salida: ${OUT_DIR}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  });

  const resultados: TesisVVCA[] = [];
  for (const reg of registros) {
    resultados.push(await auditarRegistro(ctx, reg));
  }
  await browser.close();

  // Guardar JSON de auditoría
  const jsonPath = path.join(OUT_DIR, 'auditoria_vvca.json');
  fs.writeFileSync(jsonPath, JSON.stringify(resultados, null, 2), 'utf-8');

  // Reporte consola
  console.log('\n══════════════════════════════════════════════');
  console.log('  REPORTE AUDITORÍA VVCA — RESULTADO FINAL');
  console.log('══════════════════════════════════════════════\n');
  for (const t of resultados) {
    console.log(`${t.vvca_semaforo} Registro ${t.registro} — Score: ${t.vvca_score}/100`);
    console.log(`   Número:    ${t.numero_tesis}`);
    console.log(`   Tipo:      ${t.tipo_tesis}`);
    console.log(`   Instancia: ${t.sala}`);
    console.log(`   Época:     ${t.epoca}`);
    console.log(`   Materia:   ${t.materia}`);
    console.log(`   Rubro:     ${t.rubro.slice(0, 120)}`);
    console.log(`   Texto:     ${t.texto_completo.slice(0, 300)}`);
    console.log(`   VVCA:      ${t.vvca_observacion}`);
    console.log(`   Screenshot: ${t.screenshot}`);
    console.log();
  }
  console.log(`📄 JSON guardado: ${jsonPath}`);
}

main();
