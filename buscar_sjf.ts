/**
 * buscar_sjf.ts — búsqueda por palabras clave en SJF, devuelve registros verificables
 * Uso: npx ts-node --esm buscar_sjf.ts "ampliacion termino familiar" "interes superior menor prueba"
 * Salida: JSON con registros encontrados listos para vvca_audit.ts
 */
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SJF_SEARCH = 'https://sjf2.scjn.gob.mx/busqueda-principal-tesis';

interface ResultadoBusqueda {
  termino: string;
  registros: { registro: string; rubro: string; tipo: string; materia: string }[];
}

async function buscarTermino(termino: string, maxResultados = 5) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  });

  console.log(`\n🔍 Buscando: "${termino}"`);

  try {
    await page.goto(SJF_SEARCH, { waitUntil: 'networkidle', timeout: 60000 });

    // Llenar campo de búsqueda
    const inputSel = 'input[placeholder*="palábra"], input[type="search"], input[name*="busqueda"], input[name*="palabra"], #palabra-clave, .search-input, input[type="text"]';
    await page.waitForSelector(inputSel, { timeout: 15000 }).catch(() => null);

    const inputs = await page.$$('input[type="text"], input[type="search"]');
    if (inputs.length > 0) {
      await inputs[0].fill(termino);
      await inputs[0].press('Enter');
    } else {
      // Intentar con URL directa con parámetro
      await page.goto(`${SJF_SEARCH}?palabra-clave=${encodeURIComponent(termino)}`, { waitUntil: 'networkidle', timeout: 30000 });
    }

    await page.waitForTimeout(3000);

    // Extraer registros de los resultados
    const resultados = await page.evaluate((max: number) => {
      const items: { registro: string; rubro: string; tipo: string; materia: string }[] = [];

      // Buscar links de tesis con número de registro
      const links = Array.from(document.querySelectorAll('a[href*="/detalle/tesis/"]'));
      for (const link of links.slice(0, max * 3)) {
        const href = (link as HTMLAnchorElement).href;
        const match = href.match(/\/detalle\/tesis\/(\d+)/);
        if (!match) continue;
        const registro = match[1];

        const container = link.closest('div, article, li, tr') || link.parentElement;
        const texto = container?.innerText || link.textContent || '';
        const lineas = texto.split('\n').map(l => l.trim()).filter(Boolean);

        const rubro = lineas.find(l => l.length > 20 && l === l.toUpperCase()) || lineas[0] || '';
        const tipo = lineas.find(l => /jurisprudencia|aislada|precedente/i.test(l)) || '';
        const materia = lineas.find(l => /civil|familiar|constit|penal|admin|fiscal/i.test(l)) || '';

        if (registro && !items.find(i => i.registro === registro)) {
          items.push({ registro, rubro: rubro.slice(0, 150), tipo, materia });
          if (items.length >= max) break;
        }
      }

      // Si no hay links directos, buscar números de registro en texto
      if (items.length === 0) {
        const textoCompleto = document.body.innerText;
        const matches = textoCompleto.match(/\b(20\d{5})\b/g) || [];
        const unicos = [...new Set(matches)].slice(0, max);
        unicos.forEach(r => items.push({ registro: r, rubro: '', tipo: '', materia: '' }));
      }

      return items;
    }, maxResultados);

    console.log(`  ✅ Encontrados: ${resultados.length} registros`);
    resultados.forEach(r => console.log(`     • ${r.registro} — ${r.rubro.slice(0, 80)}`));

    await browser.close();
    return { termino, registros: resultados };

  } catch (err) {
    console.error(`  ❌ Error buscando "${termino}":`, (err as Error).message);
    await browser.close();
    return { termino, registros: [] };
  }
}

async function main() {
  const terminos = process.argv.slice(2);
  if (!terminos.length) {
    console.error('Uso: npx ts-node --esm buscar_sjf.ts "termino1" "termino2" ...');
    process.exit(1);
  }

  const resultados: ResultadoBusqueda[] = [];
  for (const t of terminos) {
    const res = await buscarTermino(t, 5);
    resultados.push(res);
  }

  const outPath = path.join(process.cwd(), 'busqueda_sjf.json');
  fs.writeFileSync(outPath, JSON.stringify(resultados, null, 2), 'utf-8');
  console.log(`\n📄 Resultados guardados: ${outPath}`);

  // Lista plana de registros únicos para pasar a vvca_audit.ts
  const todosRegistros = [...new Set(resultados.flatMap(r => r.registros.map(x => x.registro)))];
  console.log(`\n▶ Registros para auditar: ${todosRegistros.join(' ')}`);
}

main();
