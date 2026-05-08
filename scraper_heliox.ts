import { chromium } from 'playwright';
import * as fs from 'fs';

async function scrape(termino: string, outputPath: string) {
  console.log(`\n🔍 Buscando: "${termino}"...`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  try {
    await page.goto('https://sjf2.scjn.gob.mx/busqueda-principal-tesis', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await page.waitForTimeout(2000);
    await page.waitForSelector('input[name="search"]', { state: 'visible', timeout: 20000 });
    await page.fill('input[name="search"]', termino);
    await page.press('input[name="search"]', 'Enter');
    await page.waitForSelector('a.list-group-item.element-item-b1', { timeout: 30000 });

    const tesis = await page.evaluate(() => {
      const items = document.querySelectorAll('a.list-group-item.element-item-b1');
      return Array.from(items).map((item) => {
        const texto = (item as HTMLElement).innerText;
        return {
          registro: texto.match(/Registro digital:\s*(\d+)/)?.[1] || 'N/A',
          texto_completo: texto.split('\n').filter((t) => t.trim() !== '').slice(0, 3).join(' | '),
        };
      });
    });

    fs.writeFileSync(outputPath, JSON.stringify(tesis, null, 2));
    console.log(`✅ "${termino}": ${tesis.length} resultados → ${outputPath}`);
  } catch (err) {
    console.error(`❌ Error con "${termino}":`, err);
    fs.writeFileSync(outputPath, JSON.stringify([], null, 2));
  } finally {
    await browser.close();
  }
}

async function main() {
  const busquedas = [
    { termino: 'subcontratación irretroactividad reforma 2021', archivo: '/home/licjo/jurisprudencia/heliox_subcontratacion.json' },
    { termino: 'prueba documental materia fiscal valoración', archivo: '/home/licjo/jurisprudencia/heliox_prueba_documental.json' },
    { termino: 'crédito fiscal requisitos validez', archivo: '/home/licjo/jurisprudencia/heliox_credito_fiscal.json' },
  ];

  for (const b of busquedas) {
    await scrape(b.termino, b.archivo);
    await new Promise(r => setTimeout(r, 2000)); // pausa entre búsquedas
  }
  console.log('\n🏁 Scraping completado para Carpeta 2024/TJAEJ/00891');
}

main().catch(console.error);
