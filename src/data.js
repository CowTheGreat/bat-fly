export async function loadData(){
  const [circuit, locomotor] = await Promise.all([
    fetch('/data/circuit.json').then(r=>r.json()),
    fetch('/data/locomotor_circuit.json').then(r=>r.json()).catch(()=>null),
  ]);
  return { circuit, locomotor };
}
