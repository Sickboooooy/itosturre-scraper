/** Pruebas OFFLINE del fallback y la clasificación de fallos SJF. */
import {
  SJF_PORTALS,
  aggregateFailureStatus,
  buildDetailUrl,
  classifySjfFailure,
  type SjfAttemptTrace,
} from './sjf_resilience.js';

let fails = 0;
function check(name: string, condition: boolean): void {
  if (!condition) fails++;
  console.log(`  ${condition ? '✅' : '❌'} ${name}`);
}

check('orden de fallback: sjf2 antes de sjfsemanal',
  SJF_PORTALS.map(p => p.id).join(',') === 'sjf2,sjfsemanal');
check('URL de detalle conserva el registro',
  buildDetailUrl(SJF_PORTALS[1], '2031640').endsWith('/detalle/tesis/2031640'));
check('clasifica ausencia confirmada', classifySjfFailure(new Error('SJF_NOT_FOUND: HTTP 404')) === 'NOT_FOUND');
check('clasifica bloqueo', classifySjfFailure(new Error('SJF_ACCESS_BLOCKED: acceso denegado')) === 'ACCESS_BLOCKED');
check('clasifica timeout', classifySjfFailure(new Error('page.goto: Timeout 45000ms exceeded')) === 'TIMEOUT');
check('clasifica cambio de layout', classifySjfFailure(new Error('SJF_LAYOUT_CHANGED: selector ausente')) === 'LAYOUT_CHANGED');

const base = {
  portal: 'sjf2' as const,
  url: 'https://sjf2.scjn.gob.mx/detalle/tesis/SYN',
  attempt: 1,
  started_at: '2026-07-31T00:00:00Z',
  finished_at: '2026-07-31T00:00:01Z',
  status: 'FAILED' as const,
};
const notFound: SjfAttemptTrace[] = [
  { ...base, failure_class: 'NOT_FOUND' },
  { ...base, portal: 'sjfsemanal', failure_class: 'NOT_FOUND' },
];
const technical: SjfAttemptTrace[] = [
  { ...base, failure_class: 'TIMEOUT' },
  { ...base, portal: 'sjfsemanal', failure_class: 'ACCESS_BLOCKED' },
];
check('dos ausencias confirmadas no son fallo técnico', aggregateFailureStatus(notFound) === 'NO_ENCONTRADO');
check('fallos técnicos producen NO_VERIFICABLE', aggregateFailureStatus(technical) === 'NO_VERIFICABLE');

console.log(fails === 0
  ? '\n🟢 resilience.test OK — fallback y clasificación correctos.'
  : `\n❌ resilience.test — ${fails} caso(s) fallaron.`);
process.exit(fails === 0 ? 0 : 1);
