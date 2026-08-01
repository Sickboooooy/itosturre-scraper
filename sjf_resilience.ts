/** Contratos puros para resiliencia y trazabilidad de consultas al SJF. */

export type SjfPortalId = 'sjf2' | 'sjfsemanal';
export type SjfFailureClass =
  | 'NOT_FOUND'
  | 'ACCESS_BLOCKED'
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
