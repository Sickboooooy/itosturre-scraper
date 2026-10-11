/** Contratos puros para resiliencia y trazabilidad de consultas al SJF. */

export type SjfPortalId = 'sjf2' | 'sjfsemanal';
export type SjfFailureClass =
  | 'NOT_FOUND'
  | 'ACCESS_BLOCKED'
  | 'ACCESS_CHALLENGE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'LAYOUT_CHANGED'
  | 'UNKNOWN';

export interface SjfPortal {
  id: SjfPortalId;
  baseUrl: string;
}

export interface SjfAttemptTrace {
  portal: SjfPortalId | 'cache';
  url: string;
  attempt: number;
  started_at: string;
  finished_at: string;
  status: 'SUCCESS' | 'FAILED' | 'CACHE_HIT';
  failure_class?: SjfFailureClass;
  message?: string;
}

// Solo interfaces públicas del Semanario. No se consumen endpoints internos no documentados.
export const SJF_PORTALS: readonly SjfPortal[] = [
  { id: 'sjf2', baseUrl: 'https://sjf2.scjn.gob.mx' },
  { id: 'sjfsemanal', baseUrl: 'https://sjfsemanal.scjn.gob.mx' },
] as const;

export function buildDetailUrl(portal: SjfPortal, registro: string): string {
  return `${portal.baseUrl}/detalle/tesis/${registro}`;
}

export function buildSearchUrl(portal: SjfPortal): string {
  return `${portal.baseUrl}/busqueda-principal-tesis`;
}

export function classifySjfFailure(error: unknown): SjfFailureClass {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  // Antes que el layout: la página del desafío no trae el marcador "Registro digital" y se
  // confundía con un cambio del portal.
  if (/sjf_access_challenge|incapsula|anti-?bots/.test(normalized)) {
    return 'ACCESS_CHALLENGE';
  }
  if (/sjf_not_found|http\s*404|tesis no encontrada|sin resultados/.test(normalized)) {
    return 'NOT_FOUND';
  }
  if (/sjf_access_blocked|acceso denegado|access denied|http\s*403|forbidden|blocked/.test(normalized)) {
    return 'ACCESS_BLOCKED';
  }
  if (/sjf_layout_changed|layout|selector|registro digital ausente/.test(normalized)) {
    return 'LAYOUT_CHANGED';
  }
  if (/timeout|timed out|exceeded/.test(normalized)) {
    return 'TIMEOUT';
  }
  if (/net::|dns|econn|connection|socket|network|name_not_resolved/.test(normalized)) {
    return 'NETWORK_ERROR';
  }
  return 'UNKNOWN';
}

export function aggregateFailureStatus(
  attempts: readonly SjfAttemptTrace[],
): 'NO_ENCONTRADO' | 'NO_VERIFICABLE' | 'LAYOUT_INCOMPATIBLE' {
  const failures = attempts
    .filter(a => a.status === 'FAILED')
    .map(a => a.failure_class);
  if (failures.length > 0 && failures.every(f => f === 'NOT_FOUND')) return 'NO_ENCONTRADO';
  if (failures.includes('LAYOUT_CHANGED')) return 'LAYOUT_INCOMPATIBLE';
  return 'NO_VERIFICABLE';
}

// ── Desafío anti-bots ─────────────────────────────────────────────────────────

/** Lo mínimo de una página de Playwright que necesita esperarDesafioAntiBots. */
export interface PaginaSjf {
  content(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  reload(opciones?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
}

/** Página de desafío anti-bots (Incapsula/Imperva) que el SJF sirve a veces antes del
 *  contenido. No es un cambio de layout ni un bloqueo definitivo. */
export function esDesafioAntiBots(html: string): boolean {
  return /_Incapsula_Resource|Incapsula incident ID/i.test(html);
}

async function contenidoActual(page: PaginaSjf): Promise<string> {
  try {
    return await page.content();
  } catch {
    // Navegación en curso (el script del desafío recarga la página): todavía sin contenido.
    return '_Incapsula_Resource';
  }
}

/**
 * En un navegador real, el propio script del sitio resuelve el desafío y recarga. Se espera a
 * que termine —con a lo sumo una recarga, como haría una persona— sin alterar el navegador ni
 * insistir. Si no se resuelve en `timeoutMs`, falla como ACCESS_CHALLENGE (no LAYOUT_CHANGED,
 * que haría creer que cambió el portal): el agregado queda NO_VERIFICABLE.
 */
export async function esperarDesafioAntiBots(
  page: PaginaSjf,
  { timeoutMs = 20000, pasoMs = 1500, ahora = Date.now }:
    { timeoutMs?: number; pasoMs?: number; ahora?: () => number } = {},
): Promise<'SIN_DESAFIO' | 'RESUELTO'> {
  if (!esDesafioAntiBots(await contenidoActual(page))) return 'SIN_DESAFIO';
  console.log('  [ANTI-BOTS] página de desafío del sitio; se espera a que el navegador la resuelva…');
  const inicio = ahora();
  let recargado = false;
  while (ahora() - inicio < timeoutMs) {
    await page.waitForTimeout(pasoMs);
    if (!esDesafioAntiBots(await contenidoActual(page))) return 'RESUELTO';
    if (!recargado && ahora() - inicio >= timeoutMs / 2) {
      recargado = true;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
    }
  }
  throw new Error('SJF_ACCESS_CHALLENGE: el desafío anti-bots del sitio no se resolvió a tiempo');
}

// ── Época y fuente de la ficha de la tesis ────────────────────────────────────

const EPOCA_POR_SUFIJO: Record<string, string> = {
  '5a.': 'Quinta Época', '6a.': 'Sexta Época', '7a.': 'Séptima Época', '8a.': 'Octava Época',
  '9a.': 'Novena Época', '10a.': 'Décima Época', '11a.': 'Undécima Época', '12a.': 'Duodécima Época',
};
const LINEA_EPOCA = /^(Quinta|Sexta|S[ée]ptima|Octava|Novena|D[ée]cima|Und[ée]cima|Duod[ée]cima)\s+[ÉE]poca$/i;

/** Época de la tesis leída del bloque de datos (desde "Registro digital:"). Nunca del
 *  encabezado del portal: ese anuncia la época VIGENTE del Semanario, no la de la tesis. */
export function epocaDeFicha(lineas: readonly string[]): string {
  const inicio = lineas.findIndex(l => /^Registro digital\s*:/i.test(l.trim()));
  if (inicio === -1) return '';
  return lineas.slice(inicio).map(l => l.trim()).find(l => LINEA_EPOCA.test(l)) ?? '';
}

/** Época que declara la clave de la tesis: "1a./J. 24/2014 (10a.)" → "Décima Época". */
export function epocaDeClave(clave: string): string {
  const m = /\((\d{1,2}a\.)\)\s*$/.exec((clave ?? '').trim());
  return m ? EPOCA_POR_SUFIJO[m[1]] ?? '' : '';
}

/** Fuente completa: la línea "Fuente:" más sus continuaciones (Libro, Tomo, página). */
export function fuenteDeFicha(lineas: readonly string[]): string {
  const i = lineas.findIndex(l => /^Fuente\s*:/i.test(l.trim()));
  if (i === -1) return '';
  const partes = [lineas[i].trim().replace(/^Fuente\s*:\s*/i, '')];
  for (const linea of lineas.slice(i + 1, i + 3).map(l => l.trim())) {
    if (/^(Libro|Tomo|Volumen|Parte)\b/i.test(linea) || /p[áa]gina\s+\d/i.test(linea)) partes.push(linea);
    else break;
  }
  return partes.filter(Boolean).join(' ');
}

// ── Ficha cargada ─────────────────────────────────────────────────────────────

const FICHA_CON_REGISTRO = /Registro digital\s*:\s*\d{4,}/i;
const FICHA_NO_ENCONTRADA = /tesis no encontrada|registro no encontrado|sin resultados/i;

/**
 * El portal pinta primero la plantilla de la ficha ("Registro digital: -1") y después la llena.
 * Se espera a que aparezca el número de registro real (o el aviso de no encontrada, que
 * clasifica quien llama). Si vence el plazo con la plantilla vacía, es TIMEOUT —reintentable—;
 * solo si ni siquiera está el marcador de la ficha es cambio de layout.
 */
export async function esperarFichaCargada(
  leerTexto: () => Promise<string>,
  esperar: (ms: number) => Promise<void>,
  { timeoutMs = 20000, pasoMs = 500, asentarMs = 800, ahora = Date.now }:
    { timeoutMs?: number; pasoMs?: number; asentarMs?: number; ahora?: () => number } = {},
): Promise<void> {
  const inicio = ahora();
  let texto = '';
  while (ahora() - inicio < timeoutMs) {
    texto = await leerTexto().catch(() => '');
    if (FICHA_NO_ENCONTRADA.test(texto)) return;
    if (FICHA_CON_REGISTRO.test(texto)) {
      await esperar(asentarMs);  // un respiro para que termine de pintar el resto de la ficha
      return;
    }
    await esperar(pasoMs);
  }
  if (!/Registro digital\s*:/i.test(texto)) {
    throw new Error('SJF_LAYOUT_CHANGED: marcador Registro digital ausente');
  }
  throw new Error('SJF_TIMEOUT: el detalle de la tesis no terminó de cargar (plantilla sin número de registro)');
}

