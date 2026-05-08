import { chromium } from 'playwright';
import * as fs from 'fs';

async function main() {
  console.log("🚀 Iniciando Misión V2.2: Desambiguación...");

  const browser = await chromium.launch({
    headless: true, 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 } // Forzamos resolución Desktop para evitar menús móviles
  });

  const page = await context.newPage();

  try {
    console.log("1️⃣  Entrando a la Corte...");
    await page.goto("https://sjf2.scjn.gob.mx/", { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    console.log("2️⃣  Buscando el botón de menú activo...");
    // Buscamos todos los botones que puedan ser el menú
    const menuBtns = page.locator('#menu');
    const countMenus = await menuBtns.count();
    console.log(`   -> Encontré ${countMenus} botones de menú.`);
    
    // Le damos clic al primero que sea visible
    let menuAbierto = false;
    for (let i = 0; i < countMenus; i++) {
        if (await menuBtns.nth(i).isVisible()) {
            console.log(`   -> Clic al botón #${i+1}...`);
            await menuBtns.nth(i).click({ force: true });
            menuAbierto = true;
            break;
        }
    }

    if (!menuAbierto) {
        console.log("⚠️ No encontré botón visible, intentando clic ciego en el primero...");
        await menuBtns.first().click({ force: true });
    }
    
    console.log("⏳ Esperando reacción...");
    await page.waitForTimeout(2000);

    console.log("3️⃣  Buscando el input correcto (El Gemelo Bueno)...");
    // Estrategia: Buscar TODOS los inputs dentro de cualquier #myDropdown
    const inputs = page.locator('#myDropdown input');
    const countInputs = await inputs.count();
    console.log(`   -> Encontré ${countInputs} cajas de texto potenciales.`);

    let inputEncontrado = false;
    for (let i = 0; i < countInputs; i++) {
        const input = inputs.nth(i);
        // Verificamos si este input específico es visible
        if (await input.isVisible()) {
            console.log(`   ✅ ¡Bingo! El input #${i+1} es el visible. Escribiendo...`);
            await input.fill('Inteligencia Artificial');
            await input.press('Enter');
            inputEncontrado = true;
            break;
        }
    }

    if (!inputEncontrado) {
        throw new Error("Ningún input se hizo visible después del clic.");
    }

    console.log("🚀 Búsqueda enviada. Esperando lista de tesis...");
    // Espera larga para la carga de resultados
    await page.waitForTimeout(8000);

    console.log("📸 ¡FOTO DE LA VICTORIA!");
    await page.screenshot({ path: 'victoria_final.png' });

    // Extracción de texto para confirmar
    const textos = await page.evaluate(() => {
        // Intentamos pescar los rubros (títulos)
        // Usamos selectores comunes de tablas o listas
        const rubros = Array.from(document.querySelectorAll('td, h4, div[role="row"]'))
            .map(e => (e as HTMLElement).innerText)
            .filter(t => t.length > 50) // Filtramos textos cortos
            .slice(0, 3);
        return rubros;
    });

    console.log("📜 MUESTRA DE RESULTADOS:");
    console.log(textos);

    const outputPath = '/home/licjo/jurisprudencia/tesis_test.json';
    fs.writeFileSync(outputPath, JSON.stringify(textos, null, 2));
    console.log(`💾 Guardado en ${outputPath}`);

  } catch (error) {
    console.error("❌ Error:", error);
    await page.screenshot({ path: 'error_v2_2.png' });
  } finally {
    await browser.close();
  }
}

main();