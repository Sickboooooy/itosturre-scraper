import { chromium } from 'playwright';
import * as fs from 'fs';

async function main() {
  console.log('🚀 Buscando jurisprudencia sobre DELITOS FISCALES...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  const page = await context.newPage();

  try {
    console.log('1️⃣  Navegando a SJF...');
    await page.goto('https://sjf2.scjn.gob.mx/busqueda-principal-tesis', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await page.waitForTimeout(2000);

    console.log('2️⃣  Buscando input...');
    const selectorInput = 'input[name="search"]';
    await page.waitForSelector(selectorInput, { state: 'visible', timeout: 20000 });

    console.log('3️⃣  Escribiendo "delitos fiscales"...');
    await page.fill(selectorInput, 'delitos fiscales');
    await page.press(selectorInput, 'Enter');

    console.log('4️⃣  Esperando resultados...');
    await page.waitForSelector('a.list-group-item.element-item-b1', { timeout: 30000 });

    console.log('5️⃣  Capturando pantalla...');
    await page.screenshot({ path: '/home/licjo/jurisprudencia/capturas/delitos_fiscales_1.png' });

    console.log('6️⃣  Extrayendo registros...');
    const tesis = await page.evaluate(() => {
      const items = document.querySelectorAll('a.list-group-item.element-item-b1');
      return Array.from(items).slice(0, 2).map((item, idx) => {
        const texto = (item as HTMLElement).innerText;
        return {
          numero: idx + 1,
          registro: texto.match(/Registro digital:\s*(\d+)/)?.[1] || 'N/A',
          rubro: texto.split('\n')[0] || 'N/A',
          texto_completo: texto.split('\n').filter((t) => t.trim() !== '').slice(0, 3).join(' - '),
        };
      });
    });

    console.log(`✅ ENCONTRADOS: ${tesis.length} registros`);
    console.log(JSON.stringify(tesis, null, 2));

    fs.writeFileSync('/home/licjo/jurisprudencia/delitos_fiscales.json', JSON.stringify(tesis, null, 2));
    console.log('💾 Guardado en delitos_fiscales.json');

  } catch (error) {
    console.error('❌ Error:', error);
    await page.screenshot({ path: '/home/licjo/jurisprudencia/capturas/delitos_fiscales_error.png' });
  } finally {
    await browser.close();
  }
}

main();
