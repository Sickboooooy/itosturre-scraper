import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SJF_URL   = 'https://sjf2.scjn.gob.mx/busqueda-principal-tesis';
const SEL_INPUT = 'input[name="search"]';
const SEL_ITEM  = 'a.list-group-item.element-item-b1';

async function main() {
  const termino = process.argv[2];
  if (!termino) {
    console.error('Uso: npx ts-node --esm scraper_final.ts "término de búsqueda" [salida.json]');
    process.exit(1);
  }
  const outPath = process.argv[3] ?? `tesis_${termino.replace(/\s+/g, '_').toLowerCase().slice(0, 60)}.json`;

  console.log(`\n🚀 Scraper SJF — búsqueda individual`);
  console.log(`🔍 Término: "${termino}"`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    await page.goto(SJF_URL, { waitUntil: 'load', timeout: 60000 });

    const inputVisible = await page.waitForSelector(SEL_INPUT, { state: 'visible', timeout: 20000 })
      .then(() => true).catch(() => false);

    if (!inputVisible) {
      // Fallback: navegar desde el menú principal
      console.log('🧭 Fallback — navegando desde menú...');
      await page.goto('https://sjf2.scjn.gob.mx/', { waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector('li#liSearch', { state: 'attached', timeout: 15000 });
      await page.click('li#liSearch');
      await page.waitForSelector('li#liSearch .dropdown-content a:has-text("Tesis")', { state: 'visible', timeout: 15000 });
      await page.click('li#liSearch .dropdown-content a:has-text("Tesis")');
      await page.waitForURL(/busqueda-principal-tesis/, { timeout: 30000 });
      await page.waitForSelector(SEL_INPUT, { state: 'visible', timeout: 30000 });
    }

    await page.fill(SEL_INPUT, termino);
    await page.press(SEL_INPUT, 'Enter');
    await page.waitForSelector(SEL_ITEM, { timeout: 30000 });

    const tesis = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).map((el) => {
        const lines = (el as HTMLElement).innerText
          .split('\n').map(s => s.trim()).filter(Boolean);
        return {
          registro:   lines.join(' ').match(/Registro digital:\s*(\d+)/)?.[1] ?? 'N/A',
          rubro:      lines.find(l => l === l.toUpperCase() && l.length > 10 && !l.includes('Registro')) ?? '',
          tipo_tesis: lines.find(l => /Jurisprudencia|Tesis Aislada|Precedente/i.test(l)) ?? '',
          sala:       lines.find(l => /Sala|Pleno|Tribunal|Juzgado/i.test(l) && !/Semanario/i.test(l)) ?? '',
          epoca:      lines.find(l => /época/i.test(l)) ?? '',
          materia:    lines.find(l => /Materia|Civil|Penal|Administrativa|Laboral|Común|Constitucional/i.test(l) && l.length < 80) ?? '',
        };
      });
    }, SEL_ITEM);

    console.log(`✅ ${tesis.length} tesis encontradas`);
    if (tesis[0]) console.log(`🔖 Primera: ${tesis[0].rubro}`);

    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(tesis, null, 2), 'utf-8');
    console.log(`📁 Guardado: ${outPath}`);
  } catch (err) {
    console.error('❌ Error:', err);
    await page.screenshot({ path: 'error_scraper.png' });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
