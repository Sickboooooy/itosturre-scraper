import { chromium } from 'playwright';
import * as fs from 'fs';

/**
 * Versión optimizada del scraper para el Semanario Judicial de la Federación.
 * Esta versión sigue la estrategia post‑mortem identificada durante la navegación
 * manual: hace clic en el menú de búsqueda, selecciona la opción «Tesis»,
 * espera a que se cargue la página de búsqueda principal y, tras introducir
 * el texto de búsqueda, espera de forma robusta a que aparezcan los resultados.
 */
async function main() {
  console.log('🚀 Iniciando Scraper V5: Estrategia Post‑Mortem mejorada...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  // Forzamos resolución 1920x1080 para asegurar la versión de escritorio
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // 1. NAVEGACIÓN: INTENTAMOS ACCEDER DIRECTAMENTE A LA BÚSQUEDA DE TESIS
    console.log('1️⃣  Entrando a la página de búsqueda...');
    // Para evitar fallos cuando el menú de búsqueda no se muestra,
    // navegamos primero a la ruta de búsqueda de tesis. La aplicación
    // angular devolverá la portada y redireccionará si es necesario.
    await page.goto('https://sjf2.scjn.gob.mx/busqueda-principal-tesis', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    // Esperamos un poco para que Angular hidrate los componentes
    await page.waitForTimeout(2000);

    // 2. COMPROBAMOS SI EL INPUT DE BÚSQUEDA ESTÁ PRESENTE
    const selectorInput = 'input[name="search"]';
    console.log('🔍 Verificando presencia del input de búsqueda...');
    let inputListo = false;
    try {
      await page.waitForSelector(selectorInput, { state: 'visible', timeout: 10000 });
      inputListo = true;
    } catch {
      inputListo = false;
    }

    // 3. SI EL INPUT NO ESTÁ LISTO, UTILIZAMOS EL MENÚ PARA NAVEGAR A TESIS
    if (!inputListo) {
      console.log('🧭 Input no encontrado. Navegando mediante menú...');
      // Volvemos a la portada para asegurarnos de que el menú está presente
      await page.goto('https://sjf2.scjn.gob.mx/', { waitUntil: 'networkidle', timeout: 30000 });
      // Intentamos abrir el menú “Búsqueda” haciendo clic en el elemento li#liSearch
      await page.waitForSelector('li#liSearch', { state: 'attached', timeout: 15000 });
      // Click al elemento de búsqueda (puede incluir tanto icono como texto)
      await page.click('li#liSearch');

      // Ahora esperamos a que aparezca el enlace “Tesis” dentro del dropdown
      await page.waitForSelector('li#liSearch .dropdown-content a:has-text("Tesis")', {
        state: 'visible',
        timeout: 15000,
      });
      await page.click('li#liSearch .dropdown-content a:has-text("Tesis")');

      // Esperamos la nueva URL
      await page.waitForURL(/busqueda-principal-tesis/, { timeout: 30000 });
      console.log('✅ Página de búsqueda cargada mediante menú');
      // Esperamos de nuevo a que el input esté visible
      await page.waitForSelector(selectorInput, { state: 'visible', timeout: 45000 });
    } else {
      console.log('✅ Página de búsqueda cargada directamente');
    }

    // 4. LOCALIZAR INPUT DE BÚSQUEDA
    console.log('3️⃣  Esperando input Desktop...');
    await page.waitForSelector(selectorInput, {
      state: 'visible',
      timeout: 45000,
    });

    // Usamos fill (que hace click interno) para introducir el término
    console.log("✍️  Escribiendo 'Inteligencia Artificial'...");
    await page.fill(selectorInput, 'fundamentación y motivación acto administrativo');

    // 5. ENVIAR LA BÚSQUEDA MEDIANTE ENTER
    console.log('🚀 Enviando con ENTER...');
    await page.press(selectorInput, 'Enter');

    // 6. ESPERAR A QUE APAREZCAN LOS RESULTADOS
    console.log('⏳ Esperando resultados...');
    // Ampliamos el timeout para entornos lentos y esperamos la aparición de al
    // menos un elemento de resultado. Alternativamente, podríamos esperar la URL
    // /listado-resultado-de-tesis/.
    await page.waitForSelector('a.list-group-item.element-item-b1', {
      timeout: 30000,
    });
    console.log('📸 ¡Éxito! Resultados cargados.');

    // 7. CAPTURA DE EVIDENCIA
    await page.screenshot({ path: 'triunfo_final.png' });

    // 8. EXTRACCIÓN DE DATOS
    console.log('📄 Extrayendo tesis...');
    const tesis = await page.evaluate(() => {
      const items = document.querySelectorAll('a.list-group-item.element-item-b1');
      return Array.from(items).map((item) => {
        const texto = (item as HTMLElement).innerText;
        // Obtenemos el número de registro y las dos primeras líneas de texto
        return {
          registro: texto.match(/Registro digital:\s*(\d+)/)?.[1] || 'N/A',
          texto_completo: texto
            .split('\n')
            .filter((t) => t.trim() !== '')
            .slice(0, 2)
            .join(' - '),
        };
      });
    });

    console.log(`✅ RESULTADOS ENCONTRADOS: ${tesis.length}`);
    console.log(tesis.slice(0, 3));
    fs.writeFileSync('tesis_final.json', JSON.stringify(tesis, null, 2));
  } catch (error) {
    console.error('❌ Error:', error);
    await page.screenshot({ path: 'error_final.png' });
  } finally {
    await browser.close();
  }
}

main();