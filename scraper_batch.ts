import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SJF_URL  = 'https://sjf2.scjn.gob.mx/busqueda-principal-tesis';
const SEL_INPUT = 'input[name="search"]';
const SEL_ITEM  = 'a.list-group-item.element-item-b1';
const MAX_TABS  = 2;
const MAX_RETRY = 2;

interface Tesis {
  registro: string;
  rubro: string;
  numero_tesis: string;
  tipo_tesis: string;
  sala: string;
  epoca: string;
  materia: string;
  vvca_semaforo: string;
}

async function scrapeTermino(ctx: BrowserContext, termino: string, attempt = 1): Promise<Tesis[]> {
  const page = await ctx.newPage();
  try {
    // Bug fix: 'load' no espera el render Angular — usar networkidle
    await page.goto(SJF_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector(SEL_INPUT, { state: 'visible', timeout: 20000 });
    await page.fill(SEL_INPUT, termino);
    await page.press(SEL_INPUT, 'Enter');
    await page.waitForSelector(SEL_ITEM, { timeout: 30000 });

    return await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).map((el) => {
        const lines = (el as HTMLElement).innerText
          .split('\n').map(s => s.trim()).filter(Boolean);
        const tipo_tesis = lines.find(l => /Jurisprudencia|Tesis Aislada|Precedente/i.test(l)) ?? '';
        const vvca_semaforo = /jurisprudencia/i.test(tipo_tesis) ? '🟢'
          : /aislada|precedente/i.test(tipo_tesis) ? '🟡' : '⬜';
        return {
          registro:     lines.join(' ').match(/Registro digital:\s*(\d+)/)?.[1] ?? 'N/A',
          rubro:        lines.find(l => l === l.toUpperCase() && l.length > 10 && !l.includes('Registro')) ?? '',
          numero_tesis: lines.find(l => /^Tesis:\s*/i.test(l))?.replace(/^Tesis:\s*/i, '')
                        ?? lines.find(l => /^\d+[ao]?\.\//i.test(l) || /^P\.\s/i.test(l)) ?? '',
          tipo_tesis,
          sala:         lines.find(l => /Sala|Pleno|Tribunal|Juzgado/i.test(l) && !/Semanario/i.test(l)) ?? '',
          epoca:        lines.find(l => /época/i.test(l)) ?? '',
          materia:      lines.find(l => /Materia|Civil|Penal|Administrativa|Laboral|Común|Constitucional/i.test(l) && l.length < 80) ?? '',
          vvca_semaforo,
        };
      });
    }, SEL_ITEM);
  } catch (err) {
    if (attempt <= MAX_RETRY) {
      console.warn(`  ⚠️  Reintento ${attempt}/${MAX_RETRY} → "${termino}"`);
      await page.close().catch(() => {});
      await new Promise(r => setTimeout(r, 3000 * attempt));
      return scrapeTermino(ctx, termino, attempt + 1);
    }
    console.error(`  ❌ Falló "${termino}" tras ${MAX_RETRY} intentos:`, (err as Error).message);
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

async function runPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const queue = tasks.map((task, i) => ({ task, i }));
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    let item;
    while ((item = queue.shift())) {
      results[item.i] = await item.task();
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = process.argv.slice(2);

  const busquedas: { termino: string; archivo: string }[] = args.length
    ? args.map(t => ({
        termino: t,
        archivo: `/home/licjo/jurisprudencia/${t.replace(/\s+/g, '_').toLowerCase().slice(0, 60)}.json`,
      }))
    : [
        { termino: 'imposibilidad económica obligación alimentaria',              archivo: '/home/licjo/jurisprudencia/alimentos_imposibilidad.json' },
        { termino: 'reducción pensión alimenticia incapacidad',                   archivo: '/home/licjo/jurisprudencia/alimentos_reduccion.json' },
        { termino: 'alimentos ascendientes obligación padre enfermedad',          archivo: '/home/licjo/jurisprudencia/alimentos_ascendientes.json' },
        { termino: 'interés superior menor pensión alimenticia proporcionalidad', archivo: '/home/licjo/jurisprudencia/alimentos_interes_superior.json' },
      ];

  console.log(`\n🚀 Scraper SJF — ${busquedas.length} término(s) · ${MAX_TABS} tabs paralelas`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const tareas = busquedas.map(({ termino, archivo }) => async () => {
    console.log(`\n🔍 "${termino}"...`);
    const tesis = await scrapeTermino(ctx, termino);
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, JSON.stringify(tesis, null, 2), 'utf-8');
    console.log(`  ✅ ${tesis.length} tesis → ${path.basename(archivo)}`);
    return { termino, total: tesis.length };
  });

  try {
    const resumen = await runPool(tareas, MAX_TABS);
    console.log('\n📊 Resumen:');
    resumen.forEach(r => console.log(`  • "${r.termino}": ${r.total} resultados`));
    console.log('\n🎉 Batch completo.');
  } finally {
    await browser.close();
  }
}

main();
