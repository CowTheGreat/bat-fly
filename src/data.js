export async function loadData(){
  const [circuit, locomotor] = await Promise.all([
    fetch('/data/circuit.json').then(r=>{ if(!r.ok) throw new Error('circuit '+r.status); return r.json(); }),
    fetch('/data/locomotor_circuit.json').then(r=>r.ok?r.json():null).catch(()=>null),
  ]);
  return { circuit, locomotor };
}
