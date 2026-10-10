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
