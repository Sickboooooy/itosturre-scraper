import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

function loadEnv(): { token: string; chatId: string } {
  const envPath = path.join(os.homedir(), '.claude/channels/telegram/.env');
  let token = '', chatId = '';
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      if (line.startsWith('TELEGRAM_BOT_TOKEN=')) token = line.split('=', 2)[1].trim();
      if (line.startsWith('TELEGRAM_CHAT_ID='))   chatId = line.split('=', 2)[1].trim();
    }
  }
  if (!token || !chatId) throw new Error('Token/Chat ID no encontrados en ~/.claude/channels/telegram/.env');
  return { token, chatId };
}

// BUG FIX #3: loadEnv movido a main() para error descriptivo, no excepción a nivel módulo
let TOKEN = '', CHAT_ID = '';

// BUG FIX #2: temp file para envío JSON — evita escape de shell manual frágil
function enviarTexto(texto: string) {
  const tmpFile = `/tmp/tg_msg_${Date.now()}.json`;
  fs.writeFileSync(tmpFile, JSON.stringify({ chat_id: CHAT_ID, text: texto, parse_mode: 'HTML' }), 'utf-8');
  try {
    execSync(
      `curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage"` +
      ` -H "Content-Type: application/json"` +
      ` -d @${tmpFile} > /dev/null`,
      { stdio: 'pipe' }
    );
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

// BUG FIX #1: `-F "caption=<file"` lee el contenido del archivo (antes: --form-string enviaba el path literal)
// BUG FIX #4: agregado `parse_mode=HTML` para que los <b> funcionen en el caption
function enviarFoto(imagePath: string, caption: string) {
  const captionFile = `${imagePath}.caption.txt`;
  fs.writeFileSync(captionFile, caption, 'utf-8');
  try {
    execSync(
      `curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendPhoto"` +
      ` -F "chat_id=${CHAT_ID}"` +
      ` -F "photo=@${imagePath}"` +
      ` -F "caption=<${captionFile}"` +
      ` -F "parse_mode=HTML"` +
      ` > /dev/null`,
      { stdio: 'pipe' }
    );
  } finally {
    fs.unlinkSync(captionFile);
  }
}

async function capturaYEnviar(ctx: BrowserContext, reg: string): Promise<void> {
  const page = await ctx.newPage();
  const imgPath = `/tmp/sjf_${reg}.png`;
  try {
    console.log(`  🔍 Registro ${reg}...`);
    await page.goto(`https://sjf2.scjn.gob.mx/detalle/tesis/${reg}`, {
      waitUntil: 'networkidle', timeout: 60000,
    });
    await page.waitForFunction(
      () => document.body.innerText.includes('Registro digital:'),
      { timeout: 30000 }
    );

    const meta = await page.evaluate(() => {
      const lineas = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
      const get = (clave: string) => {
        const l = lineas.find(l => new RegExp(`^${clave}`, 'i').test(l));
        return l ? l.replace(new RegExp(`^${clave}\\s*:?\\s*`, 'i'), '').trim() : '';
      };
      const tipoIdx = lineas.findIndex(l => /^Tipo\s*:/i.test(l));
      const rubro   = tipoIdx !== -1
        ? (lineas.slice(tipoIdx + 1).find(l => l === l.toUpperCase() && l.length > 20) ?? '')
        : '';
      const numero  = lineas.find(l => /^Tesis\s*:/i.test(l))?.replace(/^Tesis\s*:\s*/i, '') ?? '';
      const materia = lineas.find(l => /^Materia/i.test(l))
        ?.replace(/^Materia\([^)]*\)\s*:\s*/i, '').replace(/^Materia\s*:\s*/i, '') ?? '';
      return { rubro: rubro.slice(0, 200), numero, tipo: get('Tipo'), sala: get('Instancia'), materia };
    });

    await page.addStyleTag({ content: '.alert, .alert-warning, [class*="alert"] { display: none !important; }' });
    await page.screenshot({ path: imgPath, fullPage: false });

    const caption = [
      `📋 <b>Registro ${reg}</b>`,
      `🔖 <b>${meta.numero}</b> · ${meta.tipo}`,
      `🏛 ${meta.sala}`,
      `📚 Materia: ${meta.materia}`,
      `\n${meta.rubro}`,
      `\n🔗 sjf2.scjn.gob.mx/detalle/tesis/${reg}`,
    ].join('\n');

    enviarFoto(imgPath, caption);
    console.log(`  ✅ ${reg} enviado`);
  } catch (err) {
    console.error(`  ❌ Error en ${reg}:`, (err as Error).message);
    enviarTexto(`❌ Error al capturar registro ${reg}: ${(err as Error).message}`);
  } finally {
    await page.close();
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }
}

// OPT #5: runPool para capturas en paralelo (antes: for...of secuencial)
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
  // OPT #3: error descriptivo aquí en vez de excepción a nivel módulo
  try {
    ({ token: TOKEN, chatId: CHAT_ID } = loadEnv());
  } catch (err) {
    console.error('❌', (err as Error).message);
    process.exit(1);
  }

  const registros = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['2031913', '2031207', '2031981'];

  console.log(`\n📸 Capturando ${registros.length} tesis y enviando a Telegram...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  enviarTexto(`📸 <b>Capturas SJF</b>\nDescargando ${registros.length} tesis...`);

  try {
    await runPool(
      registros.map(reg => () => capturaYEnviar(ctx, reg)),
      3
    );
  } finally {
    await browser.close();
  }

  enviarTexto(`✅ <b>Listo.</b> ${registros.length} capturas enviadas.`);
  console.log('\n🎉 Todo enviado.');
}

main();
