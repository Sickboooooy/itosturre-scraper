import { chromium } from 'playwright';
import * as fs from 'fs';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu'] });
  const page = await (await browser.newContext({ viewport:{width:1920,height:1080} })).newPage();
  await page.goto('https://sjf2.scjn.gob.mx/busqueda-principal-tesis', { waitUntil:'networkidle', timeout:60000 });
  await page.waitForTimeout(2000);
  await page.waitForSelector('input[name="search"]', { state:'visible', timeout:20000 });
  await page.fill('input[name="search"]', 'subcontratación irretroactividad');
  await page.press('input[name="search"]', 'Enter');
  await page.waitForSelector('a.list-group-item.element-item-b1', { timeout:30000 });
  const tesis = await page.evaluate(() => Array.from(document.querySelectorAll('a.list-group-item.element-item-b1')).map(item => ({
    registro: (item as HTMLElement).innerText.match(/Registro digital:\s*(\d+)/)?.[1] || 'N/A',
    texto_completo: (item as HTMLElement).innerText.split('\n').filter(t=>t.trim()!=='').slice(0,3).join(' | ')
  })));
  fs.writeFileSync('/home/licjo/jurisprudencia/heliox_subcontratacion.json', JSON.stringify(tesis, null, 2));
  console.log(`✅ subcontratación irretroactividad: ${tesis.length} resultados`);
  await browser.close();
}
main().catch(e => { console.error('❌', e.message); fs.writeFileSync('/home/licjo/jurisprudencia/heliox_subcontratacion.json','[]'); });
