/**
 * vigencia.test.ts — prueba OFFLINE del parser de vigencia (sin tocar el SJF).
 * Corre:  npx ts-node --esm vigencia.test.ts
 */
import { detectarVigencia, type EstadoVigencia } from './vvca_audit.js';

const casos: Array<{ nombre: string; notas: string; esperado: EstadoVigencia }> = [
  { nombre: 'sin notas', notas: '', esperado: 'vigente' },
  {
    nombre: 'publicación obligatoria (NO debe ser superada)',
    notas: 'Esta tesis se publicó el viernes 10 de junio de 2022 a las 10:16 horas en el Semanario Judicial de la Federación y, por ende, se considera de aplicación obligatoria a partir del lunes 13 de junio de 2022.',
    esperado: 'vigente',
  },
  {
    nombre: 'superada por contradicción',
    notas: 'Notas:\nEsta tesis fue objeto de la contradicción de criterios 123/2020. En consecuencia, quedó superada y dejó de tener el carácter de jurisprudencia obligatoria.',
    esperado: 'superada',
  },
  {
    nombre: 'dejó de considerarse obligatoria',
    notas: 'Nota: Esta tesis dejó de considerarse de aplicación obligatoria en términos del punto noveno del Acuerdo General Plenario 1/2021.',
    esperado: 'superada',
  },
  {
    nombre: 'ya no resulta aplicable',
    notas: 'Nota: Esta jurisprudencia ya no resulta aplicable conforme a la reforma constitucional en materia judicial.',
    esperado: 'superada',
  },
  {
    nombre: 'interrumpida (interrumpió, sin "se")',
    notas: 'Nota: Por ejecutoria de 5 de mayo de 2021, la Segunda Sala interrumpió el criterio sostenido en la presente tesis.',
    esperado: 'interrumpida',
  },
  {
    nombre: 'sustituida',
    notas: 'Nota: Esta tesis fue sustituida por la diversa 1a./J. 50/2023 (11a.).',
    esperado: 'sustituida',
  },
  {
    nombre: 'sustitución DESECHADA (NO debe disparar falso positivo)',
    notas: 'Notas:\nEsta tesis fue objeto de una solicitud de sustitución que fue desechada; el criterio se mantiene firme y vigente.',
    esperado: 'vigente',
  },
  {
    nombre: 'interrupción improcedente (NO debe disparar)',
    notas: 'Nota: Se solicitó interrumpir el criterio, solicitud declarada improcedente. La tesis subsiste.',
    esperado: 'vigente',
  },
];

let fails = 0;
for (const c of casos) {
  const r = detectarVigencia(c.notas);
  const ok = r.estado_vigencia === c.esperado;
  if (!ok) fails++;
  console.log(`  ${ok ? '✅' : '❌'} ${c.nombre} → ${r.estado_vigencia}${ok ? '' : ` (esperado ${c.esperado})`}`);
}

console.log(
  fails === 0
    ? '\n🟢 vigencia.test OK — parser correcto.'
    : `\n❌ vigencia.test — ${fails} caso(s) fallaron.`,
);
process.exit(fails === 0 ? 0 : 1);
