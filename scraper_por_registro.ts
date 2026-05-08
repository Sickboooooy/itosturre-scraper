import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import * as fs from 'fs';

const MAX_TABS = 3;

interface TesisDetalle {
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
  url: string;
}

async function fetchRegistro(ctx: BrowserContext, registro: string): Promise<TesisDetalle> {
  const url = `https://sjf2.scjn.gob.mx/detalle/tesis/${registro}`;
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

    // Esperar a que Angular renderice el contenido del detalle
    await page.waitForFunction(
      () => document.body.innerText.includes('Registro digital:'),
      { timeout: 30000 }
    );

    const datos = await page.evaluate((reg) => {
      const lineas = document.body.innerText
        .split('\n').map((l: string) => l.trim()).filter(Boolean);

      const getValor = (clave: string): string => {
        const idx = lineas.findIndex((l: string) => new RegExp(`^${clave}\\s*:?\\s*`, 'i').test(l));
        if (idx === -1) return '';
        const val = lineas[idx].replace(new RegExp(`^${clave}\\s*:?\\s*`, 'i'), '').trim();
        return val || lineas[idx + 1] || '';
      };

      // Rubro: línea en MAYÚSCULAS que aparece después de "Tipo:"
      const tipoIdx = lineas.findIndex((l: string) => /^Tipo\s*:/i.test(l));
      const rubro = tipoIdx !== -1
        ? (lineas.slice(tipoIdx + 1).find((l: string) => l === l.toUpperCase() && l.length > 20) ?? '')
        : '';

      // texto_completo: todos los párrafos sustantivos después del rubro
      // Bug fix: antes solo tomaba 3 líneas >60 chars — perdía la mayor parte del cuerpo
      const rubroIdx = rubro ? lineas.indexOf(rubro) : -1;
      const texto_completo = rubroIdx !== -1
        ? lineas.slice(rubroIdx + 1)
            .filter((l: string) => l.length > 15 && !/^(Tesis|Instancia|Fuente|Época|Materia|Tipo|Registro)/i.test(l))
            .join('\n\n')
        : '';

      // numero_tesis: buscar línea "Tesis: X/Y" (con dos puntos, no el ítem de menú)
      const numero_tesis = lineas.find((l: string) => /^Tesis\s*:/i.test(l))
        ?.replace(/^Tesis\s*:\s*/i, '') ?? '';

      // materia: limpiar "(s):"
      const materia = lineas.find((l: string) => /^Materia/i.test(l))
        ?.replace(/^Materia\([^)]*\)\s*:\s*/i, '').replace(/^Materia\s*:\s*/i, '') ?? '';

      // epoca: solo el nombre, sin el subtítulo entre comillas
      const epocaFull = lineas.find((l: string) => /época/i.test(l) && !/materia/i.test(l) && !/instancia/i.test(l)) ?? '';
      const epoca = epocaFull.replace(/\s*".*"$/, '').trim();

      const tipo_tesis = getValor('Tipo');
      const vvca_semaforo = /jurisprudencia/i.test(tipo_tesis) ? '🟢'
        : /aislada|precedente/i.test(tipo_tesis) ? '🟡' : '⬜';

      return {
        registro: reg,
        rubro,
        numero_tesis,
        tipo_tesis,
        sala:        getValor('Instancia'),
        epoca,
        materia,
        fuente:      getValor('Fuente'),
        texto_completo,
        vvca_semaforo,
      };
    }, registro);

    return { ...datos, url };
  } finally {
    await page.close();
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
  const registros = process.argv.slice(2);
  if (!registros.length) {
    console.error('Uso: npx ts-node --esm scraper_por_registro.ts 2031913 2031207 2031981');
    process.exit(1);
  }

  console.log(`\n🚀 Scraper SJF por registro — ${registros.length} tesis · ${Math.min(MAX_TABS, registros.length)} tabs paralelas`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const tareas = registros.map(reg => async () => {
    console.log(`  🔍 Fetching registro ${reg}...`);
    try {
      const tesis = await fetchRegistro(ctx, reg);
      console.log(`  ✅ ${reg} — ${tesis.rubro.slice(0, 80)}...`);
      return tesis;
    } catch (err) {
      console.error(`  ❌ Error en ${reg}:`, (err as Error).message);
      return { registro: reg, rubro: 'ERROR', numero_tesis: '', tipo_tesis: '', sala: '', epoca: '', materia: '', fuente: '', texto_completo: '', vvca_semaforo: '🔴', url: '' };
    }
  });

  try {
    const resultados = await runPool(tareas, MAX_TABS);

    const outPath = '/home/licjo/jurisprudencia/por_registro.json';
    fs.writeFileSync(outPath, JSON.stringify(resultados, null, 2), 'utf-8');
    console.log(`\n📁 Guardado: ${outPath}`);
    console.log('\n📋 Resultados:\n');
    resultados.forEach(t => {
      console.log(`── Registro ${t.registro}`);
      console.log(`   Número:   ${t.numero_tesis}`);
      console.log(`   Tipo:     ${t.tipo_tesis}`);
      console.log(`   Instancia:${t.sala}`);
      console.log(`   Época:    ${t.epoca}`);
      console.log(`   Materia:  ${t.materia}`);
      console.log(`   Fuente:   ${t.fuente}`);
      console.log(`   Rubro:    ${t.rubro.slice(0, 120)}`);
      console.log(`   Texto:    ${t.texto_completo.slice(0, 250)}`);
      console.log();
    });
  } finally {
    await browser.close();
  }
}

main();
