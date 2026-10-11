/** Pruebas OFFLINE del fallback y la clasificación de fallos SJF. */
import {
  SJF_PORTALS,
  aggregateFailureStatus,
  buildDetailUrl,
  classifySjfFailure,
  epocaDeClave,
  epocaDeFicha,
  esDesafioAntiBots,
  esperarDesafioAntiBots,
  esperarFichaCargada,
  fuenteDeFicha,
  type PaginaSjf,
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

// ── Desafío anti-bots (Incapsula) ─────────────────────────────────────────────
// Observado el 10-oct-2026: el primer intento sobre /detalle/tesis/{registro} recibía la
// página del desafío y se clasificaba como LAYOUT_CHANGED (y, agregado, LAYOUT_INCOMPATIBLE:
// "cambió el portal"), aunque el segundo intento leía la tesis sin problema.
const HTML_DESAFIO = '<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW">'
  + '<script type="text/javascript" src="/_Incapsula_Resource?SWJIYLWA=719d34d3"></script></head></html>';
const HTML_TESIS = '<html><body>Registro digital: 2032638 · Tipo: Aislada</body></html>';

check('detecta la página del desafío anti-bots', esDesafioAntiBots(HTML_DESAFIO));
check('una página de tesis no es desafío', !esDesafioAntiBots(HTML_TESIS));
check('clasifica el desafío como tal, no como cambio de layout',
  classifySjfFailure(new Error('SJF_ACCESS_CHALLENGE: desafío no resuelto')) === 'ACCESS_CHALLENGE');
const desafios: SjfAttemptTrace[] = [
  { ...base, failure_class: 'ACCESS_CHALLENGE' },
  { ...base, portal: 'sjfsemanal', failure_class: 'ACCESS_CHALLENGE' },
];
check('desafíos sin resolver son NO_VERIFICABLE, no LAYOUT_INCOMPATIBLE',
  aggregateFailureStatus(desafios) === 'NO_VERIFICABLE');

/** Página falsa: devuelve los contenidos en orden (el último se repite) y lleva un reloj. */
class PaginaFalsa implements PaginaSjf {
  reloj = 0;
  recargas = 0;
  constructor(private contenidos: string[], private trasRecargar?: string) {}
  async content(): Promise<string> {
    return this.contenidos.length > 1 ? this.contenidos.shift()! : this.contenidos[0];
  }
  async waitForTimeout(ms: number): Promise<void> { this.reloj += ms; }
  async reload(): Promise<unknown> {
    this.recargas++;
    if (this.trasRecargar !== undefined) this.contenidos = [this.trasRecargar];
    return null;
  }
}
const opciones = (p: PaginaFalsa) => ({ timeoutMs: 20000, pasoMs: 1500, ahora: () => p.reloj });

const sinDesafio = new PaginaFalsa([HTML_TESIS]);
check('sin desafío no espera',
  (await esperarDesafioAntiBots(sinDesafio, opciones(sinDesafio))) === 'SIN_DESAFIO' && sinDesafio.reloj === 0);

const seResuelve = new PaginaFalsa([HTML_DESAFIO, HTML_DESAFIO, HTML_TESIS]);
check('espera a que el propio sitio resuelva el desafío, sin recargar',
  (await esperarDesafioAntiBots(seResuelve, opciones(seResuelve))) === 'RESUELTO' && seResuelve.recargas === 0);

const conRecarga = new PaginaFalsa([HTML_DESAFIO], HTML_TESIS);
check('a lo sumo una recarga, como haría una persona',
  (await esperarDesafioAntiBots(conRecarga, opciones(conRecarga))) === 'RESUELTO' && conRecarga.recargas === 1);

const persistente = new PaginaFalsa([HTML_DESAFIO]);
let errorPersistente: unknown = null;
try {
  await esperarDesafioAntiBots(persistente, opciones(persistente));
} catch (error) {
  errorPersistente = error;
}
check('si no se resuelve, falla como ACCESS_CHALLENGE',
  errorPersistente !== null && classifySjfFailure(errorPersistente) === 'ACCESS_CHALLENGE');
check('no insiste: una sola recarga y se rinde al vencer el plazo',
  persistente.recargas === 1 && persistente.reloj >= 20000 && persistente.reloj < 25000);

// ── Época y fuente de la ficha ─────────────────────────────────────────────────
// Observado el 10-oct-2026 en 12 registros: el encabezado del portal anuncia la época VIGENTE
// del Semanario ("Duodécima Época …") y el scraper la tomaba como época de cada tesis, incluso
// de una de la Novena. La fuente perdía su segunda línea (Libro, Tomo, página).
const LINEAS_PAGINA = [
  'Semanario Judicial de la Federación',
  'Tercer periodo "De la Justicia con el Pueblo"',
  'Duodécima Época "De la Justicia Pluricultural, la Igualdad Sustantiva y la Inclusión en México"',
  'Tesis',
  'Registro digital: 2006092',
  'Instancia: Primera Sala',
  'Décima Época',
  'Materia(s): Constitucional, Penal',
  'Tesis: 1a./J. 24/2014 (10a.)',
  'Fuente: Gaceta del Semanario Judicial de la Federación.',
  'Libro 5, Abril de 2014, Tomo I, página 497',
  'Tipo: Jurisprudencia',
  'PRESUNCIÓN DE INOCENCIA COMO REGLA DE TRATO PROCESAL.',
];
check('la época sale del bloque de la tesis, no del encabezado del portal',
  epocaDeFicha(LINEAS_PAGINA) === 'Décima Época');
check('sin bloque de datos no hay época que leer', epocaDeFicha(LINEAS_PAGINA.slice(0, 4)) === '');
check('época por la clave (10a.)', epocaDeClave('1a./J. 24/2014 (10a.)') === 'Décima Época');
check('época por la clave (9a.)', epocaDeClave('1a. CXCII/2011 (9a.)') === 'Novena Época');
check('época por la clave (12a.)', epocaDeClave('PR.P.T.CN. J/1 P (12a.)') === 'Duodécima Época');
check('clave sin época', epocaDeClave('sin sufijo') === '');
check('la fuente conserva Libro, Tomo y página',
  fuenteDeFicha(LINEAS_PAGINA) === 'Gaceta del Semanario Judicial de la Federación. Libro 5, Abril de 2014, Tomo I, página 497');
check('fuente de una sola línea', fuenteDeFicha(['Fuente: Semanario Judicial de la Federación.', 'Tipo: Aislada'])
  === 'Semanario Judicial de la Federación.');

// ── Ficha cargada ──────────────────────────────────────────────────────────────
// Observado el 10-oct-2026: tras resolverse el desafío, el portal pinta primero la plantilla
// ("Registro digital: -1", campos vacíos) y luego llena los datos. Leer en ese momento daba
// rubro y número vacíos, y se reportaba como cambio de layout.
function lector(textos: string[]) {
  let reloj = 0;
  return {
    leer: async () => (textos.length > 1 ? textos.shift()! : textos[0]),
    esperar: async (ms: number) => { reloj += ms; },
    ahora: () => reloj,
  };
}
const PLANTILLA = 'Tesis\nRegistro digital: -1\nInstancia:\nTesis:';
const CARGADA = 'Tesis\nRegistro digital: 160794\nInstancia: Primera Sala\nTesis: 1a. CXCII/2011 (9a.)';

const yaCargada = lector([CARGADA]);
let errorCarga: unknown = null;
try { await esperarFichaCargada(yaCargada.leer, yaCargada.esperar, { ahora: yaCargada.ahora }); } catch (e) { errorCarga = e; }
check('ficha ya cargada: sigue de inmediato', errorCarga === null);

const tardaEnCargar = lector([PLANTILLA, PLANTILLA, CARGADA]);
errorCarga = null;
try { await esperarFichaCargada(tardaEnCargar.leer, tardaEnCargar.esperar, { ahora: tardaEnCargar.ahora }); } catch (e) { errorCarga = e; }
check('espera a que la plantilla se llene con el registro real', errorCarga === null);

const nuncaCarga = lector([PLANTILLA]);
errorCarga = null;
try { await esperarFichaCargada(nuncaCarga.leer, nuncaCarga.esperar, { ahora: nuncaCarga.ahora }); } catch (e) { errorCarga = e; }
check('plantilla que nunca se llena es TIMEOUT (reintentable), no cambio de layout',
  errorCarga !== null && classifySjfFailure(errorCarga) === 'TIMEOUT');

const sinMarcador = lector(['Página distinta sin ficha']);
errorCarga = null;
try { await esperarFichaCargada(sinMarcador.leer, sinMarcador.esperar, { ahora: sinMarcador.ahora }); } catch (e) { errorCarga = e; }
check('sin el marcador de ficha sí es cambio de layout',
  errorCarga !== null && classifySjfFailure(errorCarga) === 'LAYOUT_CHANGED');

const noExiste = lector(['Tesis no encontrada']);
errorCarga = null;
try { await esperarFichaCargada(noExiste.leer, noExiste.esperar, { ahora: noExiste.ahora }); } catch (e) { errorCarga = e; }
check('registro inexistente: no se espera, decide quien llama (NOT_FOUND)', errorCarga === null);

console.log(fails === 0
  ? '\n🟢 resilience.test OK — fallback y clasificación correctos.'
  : `\n❌ resilience.test — ${fails} caso(s) fallaron.`);
process.exit(fails === 0 ? 0 : 1);
