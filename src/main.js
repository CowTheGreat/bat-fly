import * as THREE from 'three';
import { loadData } from './data.js';
import { LIFSim, SimulationClock, SpikeBus } from './brain/sim.js';
import { SignalBuilder } from './brain/signals.js';
import { buildFlyModel } from './brain/flymodel.js';

// Game: Survival — one fly mutates to bat, hunts 12 flies. Brain panel on right shows bat's live 668-neuron brain.
// Also supports classic whack mode via toggle.

const canvas = document.getElementById('c');
const gameEl = document.getElementById('game');
const fliesEl = document.getElementById('flies'), diffEl = document.getElementById('diff');
const scEl = document.getElementById('sc'), tmEl = document.getElementById('tm');
const card = document.getElementById('card'), playBtn = document.getElementById('play');
const center = document.getElementById('center');
const staminaBar = document.getElementById('staminaBar');
const aggressionFill = document.getElementById('aggressionFill');
const modeBtn = document.getElementById('modeBtn');
const batCursorEl = document.getElementById('bat');

// Brain panel
const brainCanvas = document.getElementById('brain-canvas');
const bRate = document.getElementById('b-rate'), bRateBar = document.getElementById('b-rate-bar');
const bWalk = document.getElementById('b-walk'), bWalkBar = document.getElementById('b-walk-bar');
const bNerv = document.getElementById('b-nerv'), bNervBar = document.getElementById('b-nerv-bar');
const bTurn = document.getElementById('b-turn'), bTurnBar = document.getElementById('b-turn-bar');
const bWing = document.getElementById('b-wing'), bEsc = document.getElementById('b-esc');
const bHd = document.getElementById('b-hd'), bSpd = document.getElementById('b-spd');
const bStam = document.getElementById('b-stam'), bPrey = document.getElementById('b-prey');
const bCtx = brainCanvas.getContext('2d');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1,1,-1,1,0,100);
camera.position.set(0,0,10); camera.lookAt(0,0,0);
const light = new THREE.DirectionalLight(0xffffff, 1.2); light.position.set(200,300,200); scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

// arena sizing - account for brain panel
let W, H, view = 400, brainPanelW = 360;
function getPanelW(){ return window.innerWidth < 900 ? 280 : 360; }
function resize(){
  const fullW = window.innerWidth, fullH = window.innerHeight;
  brainPanelW = getPanelW();
  // game area is remaining width; renderer size is game area
  const gameW = fullW - brainPanelW;
  W = fullW; H = fullH;
  renderer.setSize(gameW, H, false);
  // shift camera so 0,0 is center of game area, not full window
  const aspect = gameW / H;
  camera.left = -view*aspect; camera.right = view*aspect;
  camera.top = view; camera.bottom = -view;
  camera.updateProjectionMatrix();
  // brain canvas DPI
  const dpr = Math.min(2, window.devicePixelRatio||1);
  const bw = brainCanvas.clientWidth || brainPanelW;
  brainCanvas.width = bw * dpr; brainCanvas.height = 300 * dpr;
  bCtx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize', resize); resize();

// Helpers to make creature visuals — use the detailed FlyWire 3D model (legs, abdomen texture, wings)
// Old simple sphere+plane was replaced because the detailed model looks much better.
// Bat is scaled 1.45×, darkened with red eyes and larger wings; prey keeps natural colors but 0.85×.
function makeCreature(isBat){
  const m = buildFlyModel();
  const g = m.root;
  // scale — bat a little larger as requested
  const s = isBat ? 1.78 : 0.88;
  g.scale.set(s*1.15, s*1.15, s*1.15);
  // recolor for bat
  if(isBat){
    g.traverse(o=>{
      if(o.isMesh && o.material && o.material.color){
        // darken body, make wings more translucent blue, eyes red
        if(o.material.color.getHex()===0xfa0000 || o.material.color.r>0.5 && o.material.color.g<0.2){ // eye approx
          o.material.color.setHex(0xff1a1a);
          o.material.emissive = new THREE.Color(0xff0000);
          o.material.emissiveIntensity = 0.9;
        } else if(o.material.opacity !== undefined && o.material.opacity < 0.4){
          o.material.color.setHex(0x6ea8fe);
          o.material.opacity = 0.55;
        } else {
          // body dark purple-black
          o.material.color.lerp(new THREE.Color(0x0d0a1a), 0.6);
        }
      }
    });
    // enlarge wings for larger bat
    m.foldedWings.scale.set(1.38,1.38,1.38);
    // bat ears: small cones
    const earGeo = new THREE.ConeGeometry(2.2,5,8);
    const earMat = new THREE.MeshStandardMaterial({color:0x1a0f2e});
    for(const side of [-1,1]){
      const ear = new THREE.Mesh(earGeo, earMat);
      ear.position.set(side*1.8, 11.2, 6.5);
      ear.rotation.set(-0.3,0, side*0.4);
      g.add(ear);
    }
  }
  scene.add(g);
  // create proxy wing controllers for simple animation compatibility
  // detailed model uses foldedWings + blurWings; we map wingL/R to foldedWings children for rotation
  const wingL = m.foldedWings.children[0];
  const wingR = m.foldedWings.children[1];
  // also keep body ref for flash (abdomen)
  const body = m.abdomen || g;
  return { group:g, body, wingL, wingR, detail:m, isBat, _flashMats: [] };
}
function flashCreature(cre, hex, dur=160){
  const mats=[];
  cre.group.traverse(o=>{ if(o.isMesh && o.material){ mats.push(o.material); if(o.material.emissive) o.material.emissive.setHex(hex); } });
  setTimeout(()=> mats.forEach(mat=>{ if(mat.emissive) mat.emissive.setHex(0); }), dur);
}

// Load brain for bat
const { circuit, locomotor } = await loadData();
const spikeBus = new SpikeBus();
const sim = new LIFSim(circuit, spikeBus, locomotor);
const signals = new SignalBuilder();
const clock = new SimulationClock();

// Brain viz prep: compute bounds & colors
const n = sim.n;
let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
for(let i=0;i<n;i++){
  const x = sim.positions[3*i], y=sim.positions[3*i+1];
  if(Number.isFinite(x)){ minX=Math.min(minX,x); maxX=Math.max(maxX,x); }
  if(Number.isFinite(y)){ minY=Math.min(minY,y); maxY=Math.max(maxY,y); }
}
if(!Number.isFinite(minX)){ minX=-4; maxX=4; minY=-4; maxY=4; }
const pad = 0.3;
const rangeX = (maxX-minX)||4, rangeY=(maxY-minY)||4;
function roleColor(i){
  const c = sim.roleCode[i];
  if(c===1) return '#3dd68c'; // loom
  if(c===8) return '#ff4d4d'; // gf
  if(c===2||c===3) return '#6ea8fe'; // dna
  if(c===4) return '#ffb020'; // mdn
  if(c===5) return '#b794f6'; // fwd
  if(c===6) return '#a0a0a0'; // groom
  if(c===7) return '#c084fc'; // escw
  return '#6b7280';
}
const neuronColors = Array.from({length:n}, (_,i)=>roleColor(i));
const lastSpike = new Float64Array(n); lastSpike.fill(-1e9);
let totalSpikesSeen = 0;
// brain click → optogenetic stimulation (steer bat via brain)
brainCanvas.addEventListener('click', e=>{
  const rect=brainCanvas.getBoundingClientRect();
  const x=(e.clientX-rect.left)/rect.width, y=1-(e.clientY-rect.top)/rect.height;
  // map click to neuron positions near click — stimulate ~18 nearby neurons
  const cx=minX + x*rangeX, cy=minY + y*rangeY;
  const nearby=[];
  for(let i=0;i<n;i++){
    const px=sim.positions[3*i], py=sim.positions[3*i+1];
    const d=Math.hypot(px-cx, py-cy);
    if(d<0.9) nearby.push(i);
    if(nearby.length>22) break;
  }
  if(nearby.length){ sim.stimulate(nearby, 0.45, 120); spawnParticles(bat.x,bat.y,0x6ea8fe,8); playSound('flush'); }
});

// Game state
let mode = 'survival'; // 'survival' | 'whack'
const NUM_PREY = 12, TOTAL_TIME = 60, STAMINA_MAX = 10;
const BAT_INITIAL_STAMINA = 10;
const BUSH_COUNT = 5, BUSH_RADIUS = 52;
const WATER_COUNT = 3, WATER_RADIUS = 62;
let bat = { x:0,y:0,vx:0,vy:0,heading:0,wingPhase:0, speed:0 };
let prey = []; // {x,y,vx,vy,heading,wingPhase,alive,hidden,hideTimer,bushIdx}
let batMesh, preyMeshes=[];
let bushes = [];
let bushMeshes = [];
let waters = []; // 3 water bodies {x,y,radius, group}
let waterSpawnTimer=0, totalSpawned=0;
let score=0, eaten=0, timeLeft=TOTAL_TIME, stamina=STAMINA_MAX, playing=false, last=performance.now();
let sonarTimer=0;
let hits=0, hitsNeeded=10, level=1; // for whack mode
let mouse = {x:0,y:0, px:0,py:0, vx:0, vy:0};
let diff = { label:'easy', tempo:1, loomGainScale:1, pNoiseScale:1, speed:80 };

function difficultyFor(lv){
  const d=Math.min(5,lv);
  return { label:['easy','medium','hard','insane','nightmare'][d-1], tempo:0.8+d*0.18, loomGainScale:0.7+d*0.25, pNoiseScale:0.7+d*0.3, speed:70+d*28 };
}
function applyDiff(){ diff=difficultyFor(level); }

function resetWhackFly(f){ f.x=(Math.random()*0.6-0.3)*(camera.right-camera.left); f.y=(Math.random()*0.6-0.3)*(camera.top-camera.bottom); f.vx=(Math.random()<0.5?1:-1)*diff.speed*0.6; f.vy=(Math.random()<0.5?1:-1)*diff.speed*0.6; }

let particles=[], sonarRings=[], pheromones=[];
const audioCtx = (window.AudioContext||window.webkitAudioContext) ? new (window.AudioContext||window.webkitAudioContext)() : null;
function playSound(type){
  if(!audioCtx) return;
  const o=audioCtx.createOscillator(), g=audioCtx.createGain();
  o.connect(g); g.connect(audioCtx.destination);
  if(type==='eat'){ o.frequency.value=880; g.gain.value=0.12; o.detune.value=200; g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime+0.22); o.start(); o.stop(audioCtx.currentTime+0.22);
  } else if(type==='rustle'){ o.frequency.value=220; g.gain.value=0.08; o.type='square'; g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime+0.18); o.start(); o.stop(audioCtx.currentTime+0.18);
  } else if(type==='sonar'){ o.frequency.value=1200; g.gain.value=0.06; o.frequency.exponentialRampToValueAtTime(220, audioCtx.currentTime+0.32); g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime+0.32); o.start(); o.stop(audioCtx.currentTime+0.32); }
  else if(type==='flush'){ o.frequency.value=440; g.gain.value=0.07; o.frequency.linearRampToValueAtTime(660, audioCtx.currentTime+0.12); g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime+0.14); o.start(); o.stop(audioCtx.currentTime+0.14); }
}
function spawnParticles(x,y, color=0x33ff88, n=12){
  for(let i=0;i<n;i++){
    const m=new THREE.Mesh(new THREE.SphereGeometry(2.2+Math.random()*1.5,6,6), new THREE.MeshBasicMaterial({color, transparent:true, opacity:0.95}));
    m.position.set(x,y,2);
    const ang=Math.random()*Math.PI*2, spd=80+Math.random()*140;
    scene.add(m);
    particles.push({mesh:m, vx:Math.cos(ang)*spd, vy:Math.sin(ang)*spd, life:0.42+Math.random()*0.25, age:0});
  }
}
function spawnSonar(x,y){
  const g=new THREE.Mesh(new THREE.RingGeometry(6,8,32), new THREE.MeshBasicMaterial({color:0x6ea8fe, transparent:true, opacity:0.55, side:THREE.DoubleSide}));
  g.position.set(x,y,0.5); g.rotation.x=-Math.PI/2;
  scene.add(g);
  sonarRings.push({mesh:g, age:0, life:0.55});
  playSound('sonar');
}
function addPheromone(x,y){
  pheromones.push({x,y, strength:1.0, age:0});
  if(pheromones.length>24) pheromones.shift();
}
function makeBush(x,y,r){
  const g=new THREE.Group();
  const trunk=new THREE.Mesh(new THREE.CylinderGeometry(5,7,14,8), new THREE.MeshStandardMaterial({color:0x5c3a21, roughness:0.9}));
  trunk.position.set(0,0,-6); trunk.rotation.x=Math.PI/2;
  g.add(trunk);
  const greens=[0x2d6a4f,0x3a9d23,0x40916c,0x2b7a3b];
  const offsets=[[0,0],[ -14,8],[14,7],[0,14],[-10,-10],[10,-9]];
  const scales=[1,0.85,0.82,0.75,0.7,0.65];
  const foliage=[];
  for(let i=0;i<offsets.length;i++){
    const s=new THREE.Mesh(new THREE.SphereGeometry(r*0.62*scales[i],14,10), new THREE.MeshStandardMaterial({color:greens[i%greens.length], roughness:0.85}));
    s.position.set(offsets[i][0]*0.45, offsets[i][1]*0.45, 3 + Math.random()*2);
    s.scale.set(1,1,0.55);
    s.userData.baseColor=s.material.color.clone();
    g.add(s); foliage.push(s);
  }
  const rim=new THREE.Mesh(new THREE.RingGeometry(r*0.95, r*1.05, 24), new THREE.MeshBasicMaterial({color:0x95d5b2, transparent:true, opacity:0.25, side:THREE.DoubleSide}));
  rim.position.set(0,0,0.1);
  g.add(rim);
  g.position.set(x,y, -0.5);
  scene.add(g);
  return {x,y,radius:r, group:g, foliage, rim, uses:0, trampled:false, regrow:0, pheromone:0};
}
function makeWater(x,y,r=68){
  const g=new THREE.Group();
  const base=new THREE.Mesh(new THREE.CylinderGeometry(r,r,2,32), new THREE.MeshStandardMaterial({color:0x3b82f6, roughness:0.45, metalness:0.1, transparent:true, opacity:0.92}));
  base.rotation.x=Math.PI/2; base.position.set(0,0,0);
  g.add(base);
  const inner=new THREE.Mesh(new THREE.CylinderGeometry(r*0.72, r*0.72,2.4,24), new THREE.MeshStandardMaterial({color:0x60a5fa, roughness:0.5, transparent:true, opacity:0.55}));
  inner.rotation.x=Math.PI/2; inner.position.set(0,0,0.4);
  g.add(inner);
  const ring=new THREE.Mesh(new THREE.RingGeometry(r*1.02, r*1.12, 28), new THREE.MeshBasicMaterial({color:0x93c5fd, transparent:true, opacity:0.35, side:THREE.DoubleSide}));
  ring.position.set(0,0,0.6);
  g.add(ring);
  // lily pads
  for(let i=0;i<3;i++){
    const pad=new THREE.Mesh(new THREE.CircleGeometry(9+Math.random()*4,12), new THREE.MeshStandardMaterial({color:0x2d6a4f}));
    const ang=i*2.1, rad=r*0.45;
    pad.position.set(Math.cos(ang)*rad, Math.sin(ang)*rad, 0.8);
    g.add(pad);
  }
  g.position.set(x,y,-1.2);
  scene.add(g);
  return {x,y,radius:r, group:g, ring, base};
}
function clearWaters(){
  for(const w of waters) scene.remove(w.group);
  waters=[];
}
function clearWater(){ clearWaters(); } // alias
function clearBushes(){
  for(const b of bushMeshes) scene.remove(b.group);
  bushMeshes=[]; bushes=[];
  for(const ph of pheromones) if(ph.mesh) scene.remove(ph.mesh);
  pheromones=[]; particles.forEach(p=>scene.remove(p.mesh)); particles=[];
  sonarRings.forEach(s=>scene.remove(s.mesh)); sonarRings=[];
}
function spawnBushes(){
  clearBushes();
  const margin=70;
  const L=camera.left+margin, R=camera.right-margin, B=camera.bottom+margin, T=camera.top-margin;
  for(let i=0;i<BUSH_COUNT;i++){
    let x,y,tries=0;
    do{
      x= (Math.random()*0.8-0.4)*(R-L) *0.5;
      y= (Math.random()*0.8-0.4)*(T-B) *0.5;
      tries++;
      if(bushes.every(b=> Math.hypot(b.x-x,b.y-y) > BUSH_RADIUS*2.2)) break;
    }while(tries<40);
    const b=makeBush(x,y,BUSH_RADIUS);
    bushes.push(b); bushMeshes.push(b);
  }
}
function spawnWaters(){
  clearWaters();
  // 3 waters spread: left-bottom, center-bottom, right-bottom + slight variance, avoid bushes
  const spots=[
    {fx:-0.32, fy:0.82}, {fx:0.02, fy:0.78}, {fx:0.30, fy:0.85}
  ];
  for(const s of spots){
    let x,y,tries=0;
    do{
      x = s.fx*(camera.right-camera.left) + (Math.random()-0.5)*60;
      y = camera.bottom + 92 + s.fy*22 + Math.random()*18;
      tries++;
      if(bushes.every(b=> Math.hypot(b.x-x,b.y-y) > BUSH_RADIUS + 62) && waters.every(w=> Math.hypot(w.x-x,w.y-y) > WATER_RADIUS*1.9)) break;
    }while(tries<35);
    const w=makeWater(x,y,WATER_RADIUS);
    waters.push(w);
  }
}
function spawnWater(){ spawnWaters(); } // alias
function spawnFlyFromWater(){
  if(!waters.length) return;
  const water=waters[Math.floor(Math.random()*waters.length)];
  const ang=Math.random()*Math.PI*2, rad=water.radius*0.55 + Math.random()*10;
  const x=water.x + Math.cos(ang)*rad, y=water.y + Math.sin(ang)*rad;
  const m=makeCreature(false);
  m.group.position.set(x,y,0);
  const heading=Math.random()*Math.PI*2;
  spawnParticles(x,y,0x60a5fa,7);
  const p={x,y,vx:0,vy:0,heading,wingPhase:Math.random()*6, alive:true, hidden:false, hideTimer:0, bushIdx:-1, spawned:true};
  prey.push(p); preyMeshes.push(m);
  totalSpawned++;
  playSound('rustle');
}
function updateBushes(dt){
  for(const b of bushes){
    if(b.trampled){
      b.regrow -= dt;
      if(b.regrow<=0){
        b.trampled=false; b.uses=0;
        b.foliage.forEach(s=>{ s.material.color.copy(s.userData.baseColor); s.material.opacity=1; });
        b.rim.material.opacity=0.25; b.rim.material.color.setHex(0x95d5b2);
        b.group.scale.set(0.6,0.6,1); // regrow pop
        // animate back to 1
        let t=0; const grow=()=>{ t+=0.04; b.group.scale.set(0.6+t*0.4,0.6+t*0.4,1); if(t<1) requestAnimationFrame(grow); };
        grow();
      }
    }
    // pheromone decay + visual dust
    if(b.pheromone>0){ b.pheromone=Math.max(0,b.pheromone - dt*0.35); b.rim.material.opacity=0.25 + b.pheromone*0.35; }
  }
  // particles
  for(let i=particles.length-1;i>=0;i--){
    const p=particles[i]; p.age+=dt; p.mesh.position.x+=p.vx*dt; p.mesh.position.y+=p.vy*dt; p.mesh.position.z+=12*dt; p.mesh.material.opacity=1-p.age/p.life; p.vx*=0.96; p.vy*=0.96;
    if(p.age>=p.life){ scene.remove(p.mesh); particles.splice(i,1); }
  }
  for(let i=sonarRings.length-1;i>=0;i--){
    const s=sonarRings[i]; s.age+=dt; const sc=1+s.age*180; s.mesh.scale.set(sc,sc,1); s.mesh.material.opacity=0.55*(1-s.age/s.life);
    if(s.age>=s.life){ scene.remove(s.mesh); sonarRings.splice(i,1); }
  }
  // pheromone global decay
  for(let i=pheromones.length-1;i>=0;i--){ pheromones[i].age+=dt; pheromones[i].strength=Math.max(0,1-pheromones[i].age/4.5); if(pheromones[i].strength<=0) pheromones.splice(i,1); }
}
function trampleBush(b){
  b.uses++; if(b.uses>=3){ b.trampled=true; b.regrow=8; b.foliage.forEach(s=>{ s.material.color.setHex(0x8b7355); }); b.rim.material.color.setHex(0x8b7355); b.rim.material.opacity=0.15; spawnParticles(b.x,b.y,0x8b7355,14); playSound('rustle'); }
}
// survival setup
function clearCreatures(){
  for(const m of preyMeshes) scene.remove(m.group);
  if(batMesh) scene.remove(batMesh.group);
  preyMeshes=[]; batMesh=null; prey=[];
  clearWater();
  waterSpawnTimer=0;
}
function spawnSurvival(){
  clearCreatures();
  spawnBushes();
  spawnWater();
  batMesh = makeCreature(true);
  bat = { x:(Math.random()-0.5)*100, y:(Math.random()-0.5)*100, vx:0, vy:0, heading: Math.random()*Math.PI*2, wingPhase:0, speed:0 };
  batMesh.group.position.set(bat.x,bat.y,0);
  prey=[];
  preyMeshes=[];
  totalSpawned=0;
  for(let i=0;i<NUM_PREY;i++){
    let x,y;
    let tries=0;
    do{
      x=(Math.random()*0.7-0.35)*(camera.right-camera.left);
      y=(Math.random()*0.7-0.35)*(camera.top-camera.bottom);
      tries++;
    }while(Math.hypot(x-bat.x,y-bat.y)<120 && tries<20);
    const m = makeCreature(false);
    m.group.position.set(x,y,0);
    const heading=Math.random()*Math.PI*2;
    prey.push({x,y,vx:0,vy:0,heading,wingPhase:Math.random()*6, alive:true, hidden:false, hideTimer:0, bushIdx:-1, spawned:false});
    preyMeshes.push(m);
  }
  totalSpawned=NUM_PREY;
  eaten=0; score=0; timeLeft=TOTAL_TIME; stamina=BAT_INITIAL_STAMINA;
  waterSpawnTimer=3.2;
}

let whackFly = { x:0,y:0,vx:60,vy:40,heading:0,wingPhase:0 };
let whackMesh = makeCreature(false);
function resetWhack(){ resetWhackFly(whackFly); }

// mouse for whack mode
gameEl.addEventListener('mousemove', e=>{
  if(mode!=='whack') return;
  const rect = gameEl.getBoundingClientRect();
  const gx = e.clientX - rect.left, gy = e.clientY - rect.top;
  const gw = rect.width, gh = rect.height;
  mouse.x = ((gx / gw)*2 -1) * (camera.right);
  mouse.y = -((gy / gh)*2 -1) * (camera.top);
  batCursorEl.style.left = e.clientX+'px'; batCursorEl.style.top = e.clientY+'px';
});
gameEl.addEventListener('touchmove', e=>{
  if(mode!=='whack') return;
  const t=e.touches[0]; if(!t) return;
  const rect = gameEl.getBoundingClientRect();
  const gx = t.clientX - rect.left, gy = t.clientY - rect.top;
  const gw = rect.width, gh = rect.height;
  mouse.x = ((gx / gw)*2 -1) * (camera.right);
  mouse.y = -((gy / gh)*2 -1) * (camera.top);
  batCursorEl.style.left = t.clientX+'px'; batCursorEl.style.top = t.clientY+'px';
},{passive:true});

function hudSurvival(){
  const hidden = prey.filter(p=>p.alive&&p.hidden).length;
  const alive = prey.filter(p=>p.alive).length;
  fliesEl.textContent=`${eaten} eaten · ${alive} alive${hidden?` · ${hidden} hidden`:''} · ∞ from water`;
  diffEl.textContent=`stamina ${stamina.toFixed(1)}s · water spawns`;
  diffEl.style.background = stamina<3 ? '#3a1a1a' : '#1e2a44';
  scEl.textContent=score;
  tmEl.textContent=timeLeft.toFixed(1);
  const pct = Math.max(0, Math.min(1, stamina/STAMINA_MAX))*100;
  staminaBar.style.width = pct+'%';
  staminaBar.classList.toggle('low', stamina<3);
  const timeFrac = 1 - timeLeft/TOTAL_TIME;
  const aggr = Math.min(100, timeFrac*100);
  if(aggressionFill) aggressionFill.style.width = aggr.toFixed(1)+'%';
  gameEl.classList.toggle('aggressive', timeFrac > 0.55);
  const bStamEl=document.getElementById('b-stam');
  if(bStamEl) bStamEl.textContent = stamina.toFixed(1)+'s · '+alive+' alive · total '+totalSpawned;
}
function hudWhack(){ scEl.textContent=score; fliesEl.textContent=`${hits}/${hitsNeeded}`; diffEl.textContent=diff.label; tmEl.textContent=timeLeft.toFixed(1); staminaBar.style.width='0%'; }

function setCursorState(){
  // Survival = mouse always visible (bat is autonomous). Whack = custom bat cursor only while playing.
  if(mode==='survival'){
    gameEl.classList.remove('whack-playing');
    gameEl.style.cursor='auto';
    batCursorEl.style.display='none';
  } else {
    if(playing){
      gameEl.classList.add('whack-playing');
      gameEl.style.cursor='none';
      batCursorEl.style.display='block';
    } else {
      gameEl.classList.remove('whack-playing');
      gameEl.style.cursor='auto';
      batCursorEl.style.display='none';
    }
  }
}
function startSurvival(){
  mode='survival'; playing=true; spawnSurvival();
  center.style.display='none';
  setCursorState();
  last=performance.now();
  hudSurvival();
}
function startWhack(){
  mode='whack'; level=1; hits=0; score=0; timeLeft=30; playing=true; applyDiff();
  clearCreatures(); clearBushes();
  whackMesh.group.visible=true;
  resetWhack(); hudWhack();
  center.style.display='none';
  setCursorState();
  last=performance.now();
}
function start(){
  if(mode==='survival') startSurvival();
  else startWhack();
}
playBtn.onclick = start;
modeBtn.onclick = ()=>{
  mode = mode==='survival' ? 'whack' : 'survival';
  modeBtn.textContent = mode==='survival' ? 'Mode: Survival' : 'Mode: Whack';
  if(mode==='survival'){
    card.innerHTML = `<h1>Bat vs Fly — Survival 🦇</h1><p><b>One fly mutates into a bat.</b> Flies spawn <b>infinitely from 3× 💧 WATER</b> — 12 at start.</p><p style="font-size:13px;opacity:0.9">Eat forever — each fly <b>+10s</b>, 60s, infinite. Bushes (3→trampled) + scent, 3 waters.</p><button id="play">Transform &amp; Hunt</button><p style="margin-top:10px;font-size:11px;opacity:.6">Brain: LIF 668 · 3 waters · Bushes+Pheromone+Sonar</p>`;
  } else {
    card.innerHTML = `<h1>Bat vs Fly 🦇🪰</h1><p>Your cursor <em>is</em> the bat. The fly's real 668-neuron brain sees your loom and escapes.</p><p style="font-size:13px">Tag it 10× before time runs out. Each level faster.</p><button id="play">Play Whack</button>`;
  }
  document.getElementById('play').onclick=start;
  // reset visuals immediately if not playing
  if(!playing){
    if(mode==='survival'){ whackMesh.group.visible=false; }
    else { clearCreatures(); whackMesh.group.visible=true; resetWhack(); }
  }
  setCursorState();
};
whackMesh.group.visible=false;
gameEl.addEventListener('mouseenter', ()=>{ if(mode==='whack' && playing) batCursorEl.style.display='block'; });
gameEl.addEventListener('mouseleave', ()=>{ if(mode==='whack' && playing) batCursorEl.style.display='none'; });

function bushAt(x,y){
  for(let i=0;i<bushes.length;i++) if(Math.hypot(x-bushes[i].x, y-bushes[i].y) < bushes[i].radius) return i;
  return -1;
}
function nearestVisiblePrey(){
  let best=null, bestD=Infinity, bestI=-1;
  for(let i=0;i<prey.length;i++){
    const p=prey[i]; if(!p.alive) continue;
    // hidden flies are invisible unless bat is searching that bush
    if(p.hidden){
      const batInBush = bushAt(bat.x,bat.y);
      const preyBush = p.bushIdx;
      // visible only if bat is inside same bush or very close to it (<60) or within 45 of prey
      const dBatPrey = Math.hypot(p.x-bat.x, p.y-bat.y);
      const dBatBush = preyBush>=0 ? Math.hypot(bat.x-bushes[preyBush].x, bat.y-bushes[preyBush].y) : Infinity;
      if(batInBush !== preyBush && dBatPrey > 55 && dBatBush > 65) continue;
    }
    const d=Math.hypot(p.x-bat.x, p.y-bat.y);
    if(d<bestD){bestD=d; best=p; bestI=i;}
  }
  return { prey:best, dist:bestD, idx:bestI };
}
function nearestBushWithHidden(){
  let best=null,bestD=Infinity;
  for(const b of bushes){
    const has = prey.some(p=> p.alive && p.hidden && p.bushIdx===bushes.indexOf(b));
    if(!has) continue;
    const d=Math.hypot(b.x-bat.x,b.y-bat.y);
    if(d<bestD){bestD=d; best=b;}
  }
  return best;
}
function nearestBushAny(){
  let best=null,bestD=Infinity;
  for(const b of bushes){
    const d=Math.hypot(b.x-bat.x,b.y-bat.y);
    if(d<bestD){bestD=d; best=b;}
  }
  return best;
}
// alias for old calls
function nearestPrey(){ return nearestVisiblePrey(); }
function tickSurvival(dt){
  waterSpawnTimer -= dt;
  if(playing && waters.length && waterSpawnTimer<=0){
    const alive=prey.filter(p=>p.alive).length;
    if(alive < 20){
      spawnFlyFromWater();
      const w=waters[Math.floor(Math.random()*waters.length)];
      const bNear=bushes.reduce((a,b)=>{ const d=Math.hypot(b.x-w.x,b.y-w.y); return (!a||d<Math.hypot(a.x-w.x,a.y-w.y))?b:a; }, null);
      if(bNear) bNear.pheromone=Math.min(1,bNear.pheromone+0.22);
    }
    const timeFrac=Math.max(0,1-timeLeft/TOTAL_TIME);
    waterSpawnTimer = Math.max(1.0, 3.2 - timeFrac*1.2 - Math.min(eaten*0.04,1.0));
  }
  for(const w of waters){
    w.group.rotation.z += dt*0.18 + Math.random()*0.02;
    w.ring.material.opacity=0.28 + Math.sin(performance.now()*0.003 + w.x*0.01)*0.13;
  }
  const np = nearestPrey();
  const target = np.prey;
  let loomL=0, loomR=0, air=0;
  let huntAngle = bat.heading;
  // predictive intercept — lead the prey based on its velocity
  let predX = target ? target.x : 0, predY = target ? target.y : 0;
  if(target){
    const lead = Math.min(0.35, np.dist / 700);
    predX = target.x + (target.vx||0)*lead;
    predY = target.y + (target.vy||0)*lead;
    predX = Math.max(camera.left+24, Math.min(camera.right-24, predX));
    predY = Math.max(camera.bottom+24, Math.min(camera.top-24, predY));
    const dx=predX-bat.x, dy=predY-bat.y;
    huntAngle = Math.atan2(dy,dx);
    const bearing = Math.atan2(dy,dx)-bat.heading;
    let b=bearing; while(b>Math.PI) b-=2*Math.PI; while(b<-Math.PI) b+=2*Math.PI;
    const leftF = b>0?1:0.2, rightF = b<=0?1:0.2;
    const dist=np.dist;
    const loomBase = Math.max(0,1-dist/400)* (dist<170?1.5:1);
    const loom = Math.min(1, loomBase * 1.4);
    loomL = loom*leftF; loomR=loom*rightF;
    air = dist<140 ? Math.min(1,(1.4 - dist/140)*0.95):0;
  } else {
    let sb=nearestBushWithHidden();
    if(!sb){
      // no hidden known — follow pheromone scent or patrol
      let bestP=null, bestV=-1;
      for(const b of bushes){ if(b.pheromone>bestV && !b.trampled){ bestV=b.pheromone; bestP=b; }}
      if(bestP && bestV>0.25) sb=bestP;
      else sb=nearestBushAny();
      if(sb && Math.hypot(sb.x-bat.x,sb.y-bat.y) < 38){
        let second=null, sd=Infinity;
        for(const b of bushes){ if(b===sb || b.trampled) continue; const d=Math.hypot(b.x-bat.x,b.y-bat.y); if(d<sd){sd=d; second=b;}}
        if(second) sb=second;
      }
    }
    if(sb){
      predX=sb.x; predY=sb.y; huntAngle=Math.atan2(predY-bat.y, predX-bat.x);
      const dBush=Math.hypot(predX-bat.x,predY-bat.y);
      const loomBase=Math.max(0,1-dBush/500)*0.60;
      loomL=loomBase*0.5; loomR=loomBase*0.5; air= dBush<60?0.4:0;
      sb.group.scale.set(1.06,1.06,1);
      if(sb.pheromone>0.3) { sb.rim.material.opacity=0.45; }
    } else {
      predX=bat.x + Math.cos(bat.heading)*80; predY=bat.y + Math.sin(bat.heading)*80;
    }
  }
  // stamina + time modulate brain — aggressive as clock runs down
  const stamFrac = Math.max(0.35, stamina/STAMINA_MAX);
  const timeFrac = Math.max(0, Math.min(1, 1 - timeLeft/TOTAL_TIME));
  const aggression = 1 + timeFrac*0.95 + (stamina<4 ? (4-stamina)/4*0.45 : 0);
  // sonar pulse when aggressive/searching
  sonarTimer -= dt;
  if(sonarTimer<=0 && (timeFrac>0.45 || !target)){
    spawnSonar(bat.x, bat.y); sonarTimer= timeFrac>0.7 ? 0.55 : 1.1;
  }
  sim.loomL=loomL; sim.loomR=loomR; sim.airPuff=air;
  sim.activityScale = (0.95 * stamFrac + 0.65) + timeFrac*0.50;
  const ms=Math.max(1, Math.round(dt*1000));
  sim.step(ms);
  const s = signals.make(sim, dt);
  const events = spikeBus.popAll();
  for(const ev of events){ lastSpike[ev.neuron]=sim.simMs; if(ev.isGF) {} totalSpikesSeen++; }

  // bat motion — PREDATOR: speed + aggression scales with time
  const closeBoost = np.dist < 130 ? 1.55 : np.dist < 220 ? 1.25 : 1.0;
  let wantSpeed = 195 * (0.62 + s.walkDrive*1.2 + s.nervous*0.9) * (0.82 + stamFrac*0.38) * closeBoost * aggression;
  // wall avoidance steering (soft, not bounce) — weakens as aggression rises (takes more risk)
  const Ls=camera.left+18, Rs=camera.right-18, Bs=camera.bottom+18, Ts=camera.top-18;
  const wallMargin = 90, wallStrength = 1.6 * (1 - timeFrac*0.35);
  let wallBias = 0;
  {
    let wx=0, wy=0;
    if(bat.x < Ls+wallMargin) wx += (Ls+wallMargin - bat.x)/wallMargin;
    if(bat.x > Rs-wallMargin) wx -= (bat.x - (Rs-wallMargin))/wallMargin;
    if(bat.y < Bs+wallMargin) wy += (Bs+wallMargin - bat.y)/wallMargin;
    if(bat.y > Ts-wallMargin) wy -= (bat.y - (Ts-wallMargin))/wallMargin;
    if(wx!==0 || wy!==0){
      const wallAng = Math.atan2(wy,wx);
      let d = wallAng - bat.heading; while(d>Math.PI) d-=2*Math.PI; while(d<-Math.PI) d+=2*Math.PI;
      const mag = Math.min(1, Math.hypot(wx,wy));
      wallBias = Math.max(-1, Math.min(1, d*0.7)) * mag * wallStrength;
    }
  }
  let huntBias = 0;
  if(target){
    let diffA = huntAngle - bat.heading; while(diffA>Math.PI) diffA-=2*Math.PI; while(diffA<-Math.PI) diffA+=2*Math.PI;
    huntBias = Math.max(-1, Math.min(1, diffA*1.25)) * (1 + timeFrac*0.35);
  }
  // combine: hunt dominates, brain adds life, wall avoidance overrides near walls
  const combinedTurn = s.turnBias*0.30 + huntBias*1.15 + wallBias;
  if(s.escape && target){
    const ang = Math.atan2(predY-bat.y, predX-bat.x);
    bat.vx = Math.cos(ang)*(wantSpeed*2.5+240 + timeFrac*90);
    bat.vy = Math.sin(ang)*(wantSpeed*2.5+240 + timeFrac*90);
    bat.heading = ang;
  } else {
    bat.heading += combinedTurn * (6.0 + timeFrac*2.2) * dt;
    if(s.nervous>0.38) bat.heading += (Math.random()-0.5)*s.nervous*2.5*dt;
    const h=bat.heading;
    bat.vx += (Math.cos(h)*wantSpeed - bat.vx)*Math.min(1,(9+timeFrac*2)*dt);
    bat.vy += (Math.sin(h)*wantSpeed - bat.vy)*Math.min(1,(9+timeFrac*2)*dt);
  }
  // integrate then soft-clamp (preserve momentum, don't hard-bounce)
  bat.x += bat.vx*dt; bat.y += bat.vy*dt;
  if(bat.x<Ls){ bat.x=Ls; bat.vx = Math.abs(bat.vx)*0.55; }
  if(bat.x>Rs){ bat.x=Rs; bat.vx = -Math.abs(bat.vx)*0.55; }
  if(bat.y<Bs){ bat.y=Bs; bat.vy = Math.abs(bat.vy)*0.55; }
  if(bat.y>Ts){ bat.y=Ts; bat.vy = -Math.abs(bat.vy)*0.55; }
  if(bat.vx!==0 || bat.vy!==0) bat.heading = Math.atan2(bat.vy, bat.vx);
  batMesh.group.position.set(bat.x,bat.y,0);
  batMesh.group.rotation.z = bat.heading;
  // detailed wing animation — works for both simple and buildFlyModel
  bat.wingPhase += dt * 34 * (0.75 + s.wingDrive*1.15);
  if(batMesh.detail){
    // drive detailed model wing raise/blur via manual phase
    const stroke = Math.sin(bat.wingPhase);
    batMesh.detail.foldedWings.children.forEach((wing, idx)=>{
      const side = idx===0? -1:1;
      wing.rotation.z = side * (0.45 + 0.35*stroke);
      wing.rotation.x = stroke * 0.25;
    });
    if(batMesh.detail.blurWingL) batMesh.detail.blurWingL.visible = bat.speed>20;
    if(batMesh.detail.blurWingR) batMesh.detail.blurWingR.visible = bat.speed>20;
  } else {
    batMesh.wingL.rotation.z = 0.35 + Math.sin(bat.wingPhase)*1.0;
    batMesh.wingR.rotation.z = -0.35 - Math.sin(bat.wingPhase)*1.0;
  }
  bat.speed = Math.hypot(bat.vx,bat.vy);

  // prey update: flee + hide in bushes
  for(let i=0;i<prey.length;i++){
    const p=prey[i]; if(!p.alive) continue;
    const m=preyMeshes[i];
    // hidden prey — stay invisible inside bush, countdown, then emerge
    if(p.hidden){
      p.hideTimer -= dt;
      const b=bushes[p.bushIdx];
      // gentle jiggle inside foliage
      p.x = b.x + Math.sin(p.wingPhase*0.7)*6;
      p.y = b.y + Math.cos(p.wingPhase*0.9)*5;
      m.group.position.set(p.x,p.y,0);
      const dBatPrey=Math.hypot(p.x-bat.x,p.y-bat.y);
      const dBatBush=Math.hypot(bat.x-b.x, bat.y-b.y);
      // bat searches bush -> flush out, or timer expires and bat is far -> sneak out
      if(dBatPrey < 40 || dBatBush < b.radius*0.9 || (p.hideTimer<=0 && dBatPrey>90)){
        p.hidden=false; p.bushIdx=-1; p.hideTimer=0;
        m.group.visible=true; m.group.scale.set(1,1,1);
        const away=Math.atan2(p.y-bat.y,p.x-bat.x);
        p.heading=away; p.vx=Math.cos(away)*140; p.vy=Math.sin(away)*140;
        p.x += Math.cos(away)*20; p.y += Math.sin(away)*20;
      } else {
        m.group.visible=false;
        p.wingPhase += dt*18;
        // pulse bush foliage slightly to hint something is inside
        const pulse=1+Math.sin(performance.now()*0.004 + p.bushIdx)*0.07;
        b.group.scale.set(pulse,pulse,1);
        continue;
      }
    }
    const dx=p.x-bat.x, dy=p.y-bat.y, d=Math.hypot(dx,dy);
    // flies KNOW bushes — memorise positions, prefer cover; trampled bushes are ignored
    let nearestB=null, nd=Infinity, nbIdx=-1;
    for(let bi=0;bi<bushes.length;bi++){ const b=bushes[bi]; if(b.trampled) continue; const dd=Math.hypot(b.x-p.x,b.y-p.y); if(dd<nd){nd=dd; nearestB=b; nbIdx=bi;}}
    const knowsBush = nearestB && nd < 220;
    const fleeToBush = nearestB && ((d < 175 && nd < 150) || (d < 280 && nd < 80) || (knowsBush && d < 220 && nd < 120));
    if(fleeToBush && nd < nearestB.radius*0.70){
      p.hidden=true; p.hideTimer=2.8 + Math.random()*3.2; p.bushIdx=nbIdx;
      p.x = nearestB.x + (Math.random()-0.5)*8; p.y = nearestB.y + (Math.random()-0.5)*8;
      m.group.visible=false;
      nearestB.uses++; nearestB.pheromone=Math.min(1, nearestB.pheromone+0.55);
      addPheromone(nearestB.x, nearestB.y);
      if(nearestB.uses>=3) trampleBush(nearestB);
      else { nearestB.group.scale.set(1.14,1.14,1); setTimeout(()=>nearestB.group.scale.set(1,1,1),260); playSound('rustle'); spawnParticles(p.x,p.y,0x3a9d23,6); }
      const flash=m.detail?m.detail.abdomen?.material:null;
      if(flash && flash.emissive) { flash.emissive.setHex(0x2d6a4f); setTimeout(()=>flash.emissive.setHex(0),180); }
    } else if(fleeToBush){
      const toBush=Math.atan2(nearestB.y-p.y, nearestB.x-p.x);
      let diffR=toBush-p.heading; while(diffR>Math.PI) diffR-=2*Math.PI; while(diffR<-Math.PI) diffR+=2*Math.PI;
      p.heading += diffR*Math.min(1,6.0*dt);
      const fleeSpeed=112 + (175-Math.min(d,175))*0.60;
      p.vx=Math.cos(p.heading)*fleeSpeed; p.vy=Math.sin(p.heading)*fleeSpeed;
    } else if(d<150){
      const away=Math.atan2(dy,dx);
      const fleeSpeed=95 + (150-d)*0.45 + Math.random()*14;
      p.heading += (away - p.heading)*Math.min(1, 4.5*dt);
      p.heading += (Math.random()-0.5)*0.5*dt;
      p.vx = Math.cos(p.heading)*fleeSpeed;
      p.vy = Math.sin(p.heading)*fleeSpeed;
    } else {
      // idle: loiter near bushes — flies KNOW cover and stay close even without threat
      if(knowsBush && nd < 110){
        const toBush=Math.atan2(nearestB.y-p.y, nearestB.x-p.x);
        let diffR=toBush-p.heading; while(diffR>Math.PI) diffR-=2*Math.PI; while(diffR<-Math.PI) diffR+=2*Math.PI;
        p.heading += diffR*Math.min(1,1.2*dt) + (Math.random()-0.5)*0.6*dt;
        const loiterSpd=30 + Math.random()*10;
        p.vx += (Math.cos(p.heading)*loiterSpd - p.vx)*Math.min(1,1.8*dt);
        p.vy += (Math.sin(p.heading)*loiterSpd - p.vy)*Math.min(1,1.8*dt);
      } else {
        p.heading += (Math.random()-0.5)*1.0*dt;
        const wanderSpd = 34 + Math.random()*14;
        p.vx += (Math.cos(p.heading)*wanderSpd - p.vx)*Math.min(1,2.2*dt);
        p.vy += (Math.sin(p.heading)*wanderSpd - p.vy)*Math.min(1,2.2*dt);
        // occasional exploratory dash toward a random bush
        if(Math.random()<0.008 && nearestB && nd<200){
          p.heading = Math.atan2(nearestB.y-p.y, nearestB.x-p.x) + (Math.random()-0.5)*0.3;
        }
      }
    }
    // wall (prey)
    if(p.x<Ls){ p.x=Ls; p.vx=Math.abs(p.vx); p.heading=0; }
    if(p.x>Rs){ p.x=Rs; p.vx=-Math.abs(p.vx); p.heading=Math.PI; }
    if(p.y<Bs){ p.y=Bs; p.vy=Math.abs(p.vy); }
    if(p.y>Ts){ p.y=Ts; p.vy=-Math.abs(p.vy); }
    if(!p.hidden){
      p.x += p.vx*dt; p.y += p.vy*dt;
      p.heading = Math.atan2(p.vy,p.vx);
      m.group.position.set(p.x,p.y,0);
      m.group.rotation.z=p.heading;
      p.wingPhase += dt*26;
      if(m.detail){
        const stroke = Math.sin(p.wingPhase*1.8);
        m.detail.foldedWings.children.forEach((wing, idx)=>{
          const side = idx===0? -1:1;
          wing.rotation.z = side * (0.32 + 0.22*stroke);
        });
      } else {
        m.wingL.rotation.z = 0.28 + Math.sin(p.wingPhase)*0.9;
        m.wingR.rotation.z = -0.28 - Math.sin(p.wingPhase)*0.9;
      }
    }
  }
  // eat check — larger bat needs larger radius
  for(let i=0;i<prey.length;i++){
    const p=prey[i]; if(!p.alive) continue;
    const d=Math.hypot(p.x-bat.x, p.y-bat.y);
    if(d<40){
      p.alive=false; preyMeshes[i].group.visible=false;
      flashCreature(batMesh, 0x33ff88, 180);
      spawnParticles(p.x,p.y,0xffd60a,14); spawnSonar(p.x,p.y); playSound('eat');
      // disturb bush if eaten near one
      const bIdx=bushAt(p.x,p.y); if(bIdx>=0) trampleBush(bushes[bIdx]);
      eaten++; score+=150;
      stamina = STAMINA_MAX;
      // infinite — no win, keep spawning from water. Milestone flash every 12
      if(eaten%12===0){
        spawnParticles(bat.x,bat.y,0xffd60a,18); playSound('flush');
        // brief score popup handled via HUD
      }
      break;
    }
  }
  // update brain stats UI
  bRate.textContent = sim.ratePop.toFixed(1)+' Hz';
  bRateBar.style.width = Math.min(100, sim.ratePop*4)+'%';
  bWalk.textContent = s.walkDrive.toFixed(2);
  bWalkBar.style.width = Math.min(100, s.walkDrive/1.3*100)+'%';
  bNerv.textContent = s.nervous.toFixed(2);
  bNervBar.style.width = s.nervous*100+'%';
  bTurn.textContent = s.turnBias.toFixed(2);
  bTurnBar.style.width = (Math.abs(s.turnBias)*100)+'%';
  bTurnBar.style.marginLeft = s.turnBias<0? (50+ s.turnBias*50)+'%' : '50%';
  bWing.textContent = s.wingDrive.toFixed(2);
  bEsc.textContent = s.escape? 'SPIKE!': '—';
  bEsc.style.color = s.escape? '#ff4d4d':'#6b7280';
  bHd.textContent = ((bat.heading*180/Math.PI)%360).toFixed(0)+'°';
  bSpd.textContent = bat.speed.toFixed(0);
  bStam.textContent = stamina.toFixed(1)+'s';
  if(target) bPrey.textContent = np.dist.toFixed(0)+' px';
  else bPrey.textContent='—';

  // expose s for idle rendering
  tickSurvival.lastS = s;
}
tickSurvival.lastS=null;

// Whack tick (original)
function tickWhack(dt){
  mouse.vx=(mouse.x-mouse.px)/Math.max(0.001,dt);
  mouse.vy=(mouse.y-mouse.py)/Math.max(0.001,dt);
  mouse.px=mouse.x; mouse.py=mouse.y;
  const dx=mouse.x - whackFly.x, dy=mouse.y - whackFly.y;
  const dist=Math.hypot(dx,dy);
  const speed=Math.hypot(mouse.vx,mouse.vy);
  const bearing=Math.atan2(dy,dx)-whackFly.heading;
  const leftF=bearing>0?1:0.2, rightF=bearing<=0?1:0.2;
  const loomBase=Math.max(0,1-dist/260)*Math.min(1,speed/900+0.25)*(dist<120?1.4:1);
  const loom=Math.min(1, loomBase*diff.loomGainScale);
  sim.loomL=loom*leftF; sim.loomR=loom*rightF;
  sim.airPuff=dist<140?Math.min(1,(1.2-dist/140)*0.9):0;
  sim.activityScale=diff.pNoiseScale*diff.tempo; sim.sensoryGate=1;
  const ms=Math.max(1,Math.round(dt*1000)); sim.step(ms);
  const s=signals.make(sim, dt);
  const ev=spikeBus.popAll(); for(const e of ev) lastSpike[e.neuron]=sim.simMs;
  let wantSpeed=diff.speed*(0.5+s.walkDrive*0.9+s.nervous*0.6)*diff.tempo;
  if(s.escape){
    const ang=Math.atan2(whackFly.y-mouse.y, whackFly.x-mouse.x);
    whackFly.vx=Math.cos(ang)*(wantSpeed*2.2+180);
    whackFly.vy=Math.sin(ang)*(wantSpeed*2.2+180);
  } else {
    const steer=s.turnBias*3.5; whackFly.heading+=steer*dt;
    if(s.nervous>0.35) whackFly.heading+=(Math.random()-0.5)*s.nervous*6*dt;
    const h=whackFly.heading;
    whackFly.vx+=(Math.cos(h)*wantSpeed - whackFly.vx)*Math.min(1,4*dt);
    whackFly.vy+=(Math.sin(h)*wantSpeed - whackFly.vy)*Math.min(1,4*dt);
  }
  const L=camera.left+18,R=camera.right-18,B=camera.bottom+18,T=camera.top-18;
  if(whackFly.x<L){whackFly.x=L; whackFly.vx=Math.abs(whackFly.vx); whackFly.heading=0}
  if(whackFly.x>R){whackFly.x=R; whackFly.vx=-Math.abs(whackFly.vx); whackFly.heading=Math.PI}
  if(whackFly.y<B){whackFly.y=B; whackFly.vy=Math.abs(whackFly.vy)}
  if(whackFly.y>T){whackFly.y=T; whackFly.vy=-Math.abs(whackFly.vy)}
  whackFly.x+=whackFly.vx*dt; whackFly.y+=whackFly.vy*dt;
  whackFly.heading=Math.atan2(whackFly.vy,whackFly.vx);
  whackMesh.group.position.set(whackFly.x,whackFly.y,0);
  whackMesh.group.rotation.z=whackFly.heading;
  whackFly.wingPhase+=dt*28*(0.8+s.wingDrive*1.2);
  if(whackMesh.detail){
    const stroke=Math.sin(whackFly.wingPhase);
    whackMesh.detail.foldedWings.children.forEach((wing,idx)=>{ const side=idx===0?-1:1; wing.rotation.z= side*(0.32+0.22*stroke); });
  } else {
    whackMesh.wingL.rotation.z=0.28+Math.sin(whackFly.wingPhase)*0.9;
    whackMesh.wingR.rotation.z=-0.28-Math.sin(whackFly.wingPhase)*0.9;
  }
  if(playing && dist<28){
    hits++; score+=100*level;
    const ang=Math.atan2(whackFly.y-mouse.y, whackFly.x-mouse.x)||Math.random()*6.28;
    whackFly.vx=Math.cos(ang)*320; whackFly.vy=Math.sin(ang)*320;
    whackFly.x+=Math.cos(ang)*18; whackFly.y+=Math.sin(ang)*18;
    flashCreature(whackMesh, 0x66aaff, 140);
    if(hits>=hitsNeeded){
      if(level>=5){ playing=false; setCursorState(); center.style.display='grid'; card.innerHTML=`<h1>You win! 🏆</h1><p>Score ${score}</p><button id="again">Play again</button>`; document.getElementById('again').onclick=startWhack; }
      else { hits=0; level++; timeLeft=Math.max(12,30-(level-1)*3.5); applyDiff(); }
    }
  }
  // update brain stats for whack too
  bRate.textContent=sim.ratePop.toFixed(1)+' Hz'; bRateBar.style.width=Math.min(100,sim.ratePop*4)+'%';
  bWalk.textContent=s.walkDrive.toFixed(2); bWalkBar.style.width=Math.min(100,s.walkDrive/1.3*100)+'%';
  bNerv.textContent=s.nervous.toFixed(2); bNervBar.style.width=s.nervous*100+'%';
  bTurn.textContent=s.turnBias.toFixed(2); bTurnBar.style.width=(Math.abs(s.turnBias)*100)+'%';
  bWing.textContent=s.wingDrive.toFixed(2); bEsc.textContent=s.escape?'SPIKE!':'—'; bEsc.style.color=s.escape?'#ff4d4d':'#6b7280';
  bHd.textContent=(whackFly.heading*180/Math.PI).toFixed(0)+'°'; bSpd.textContent=Math.hypot(whackFly.vx,whackFly.vy).toFixed(0); bStam.textContent='—'; bPrey.textContent=dist.toFixed(0)+' px';
}

// Unified tick
function tick(dt){
  if(mode==='survival') tickSurvival(dt);
  else tickWhack(dt);
}

// Brain canvas render
function renderBrain(){
  const Wb = brainCanvas.clientWidth, Hb = 300;
  bCtx.clearRect(0,0,Wb,Hb);
  // bg grid
  bCtx.fillStyle='#080a12'; bCtx.fillRect(0,0,Wb,Hb);
  bCtx.strokeStyle='#1a2338'; bCtx.lineWidth=1;
  for(let i=0;i<Wb;i+=40){ bCtx.beginPath(); bCtx.moveTo(i,0); bCtx.lineTo(i,Hb); bCtx.stroke(); }
  for(let i=0;i<Hb;i+=40){ bCtx.beginPath(); bCtx.moveTo(0,i); bCtx.lineTo(Wb,i); bCtx.stroke(); }
  // draw neurons
  const now = sim.simMs;
  for(let i=0;i<n;i++){
    const x = sim.positions[3*i], y = sim.positions[3*i+1];
    if(!Number.isFinite(x)||!Number.isFinite(y)) continue;
    const nx = ((x - minX) / rangeX)*(Wb-16)+8;
    const ny = ((y - minY) / rangeY)*(Hb-16)+8;
    // flip y
    const py = Hb - ny;
    const rec = now - lastSpike[i];
    const spiked = rec < 80;
    const col = neuronColors[i];
    if(spiked){
      const alpha = 1 - rec/80;
      bCtx.fillStyle = `rgba(255,255,255,${0.9*alpha + 0.3})`;
      bCtx.shadowColor='#fff'; bCtx.shadowBlur=6;
      bCtx.beginPath(); bCtx.arc(nx,py, 4.5,0,Math.PI*2); bCtx.fill();
      bCtx.shadowBlur=0;
      bCtx.fillStyle=col;
      bCtx.beginPath(); bCtx.arc(nx,py, 2.2,0,Math.PI*2); bCtx.fill();
    } else {
      // brightness by membrane potential
      const v = sim.v[i];
      const bright = Math.min(1, Math.max(0, (v+0.5)/1.5));
      bCtx.fillStyle = col;
      bCtx.globalAlpha = 0.55 + bright*0.45;
      bCtx.beginPath(); bCtx.arc(nx,py, 1.9,0,Math.PI*2); bCtx.fill();
      bCtx.globalAlpha=1;
    }
  }
  bCtx.fillStyle='rgba(255,255,255,0.7)';
  bCtx.font='10px system-ui';
  bCtx.fillText(`sim ${now} ms · ${n} neurons — click to stimulate`, 8, Hb-8);
  // hint: click stimulation
  bCtx.fillStyle='rgba(110,168,254,0.55)';
  bCtx.font='9px system-ui';
  bCtx.fillText(`click brain → 22 neurons +0.45 for 120ms`, 8, Hb-20);
}
const miniMap=document.getElementById('miniMap');
const mCtx= miniMap ? miniMap.getContext('2d') : null;
function renderMiniMap(){
  if(!mCtx) return;
  const Wm=miniMap.width, Hm=miniMap.height;
  mCtx.clearRect(0,0,Wm,Hm);
  mCtx.fillStyle='#ffffff'; mCtx.fillRect(0,0,Wm,Hm);
  // grid
  mCtx.strokeStyle='#eef2f7'; mCtx.lineWidth=1;
  for(let x=0;x<Wm;x+=33){ mCtx.beginPath(); mCtx.moveTo(x,0); mCtx.lineTo(x,Hm); mCtx.stroke(); }
  for(let y=0;y<Hm;y+=30){ mCtx.beginPath(); mCtx.moveTo(0,y); mCtx.lineTo(Wm,y); mCtx.stroke(); }
  // map world to minimap
  const pad=8;
  const viewW=camera.right-camera.left, viewH=camera.top-camera.bottom;
  function wx(x){ return pad + (x-camera.left)/viewW*(Wm-pad*2); }
  function wy(y){ return Hm-pad - (y-camera.bottom)/viewH*(Hm-pad*2); }
  // waters — 3 sources
  for(const w of waters){
    const cx=wx(w.x), cy=wy(w.y), r=Math.max(7, w.radius/viewW*(Wm-pad*2)*0.88);
    mCtx.beginPath(); mCtx.arc(cx,cy,r,0,Math.PI*2);
    mCtx.fillStyle='#3b82f6'; mCtx.globalAlpha=0.22; mCtx.fill(); mCtx.globalAlpha=1;
    mCtx.strokeStyle='#2563eb'; mCtx.lineWidth=1.2; mCtx.stroke();
    mCtx.fillStyle='#60a5fa'; mCtx.beginPath(); mCtx.arc(cx,cy,r*0.60,0,Math.PI*2); mCtx.fill();
    mCtx.fillStyle='#ffffff'; mCtx.font='6px system-ui'; mCtx.fillText('WATER', cx-12, cy+2);
    const pulse=(Math.sin(performance.now()*0.004 + w.x*0.02)+1)/2;
    mCtx.strokeStyle=`rgba(59,130,246,${0.12+pulse*0.22})`; mCtx.lineWidth=1.6; mCtx.beginPath(); mCtx.arc(cx,cy,r+4+pulse*3,0,Math.PI*2); mCtx.stroke();
  }
  // bushes
  for(const b of bushes){
    const cx=wx(b.x), cy=wy(b.y), r= Math.max(6, b.radius/viewW*(Wm-pad*2)*0.9);
    mCtx.beginPath(); mCtx.arc(cx,cy,r,0,Math.PI*2);
    mCtx.fillStyle= b.trampled ? '#8b7355' : (b.pheromone>0.25 ? '#4ade80' : '#2d6a4f');
    mCtx.fill(); mCtx.strokeStyle= b.trampled?'#5c3a21':'#1a3a2a'; mCtx.lineWidth=1.2; mCtx.stroke();
    if(b.pheromone>0.15){ mCtx.beginPath(); mCtx.arc(cx,cy,r+4,0,Math.PI*2); mCtx.strokeStyle=`rgba(74,222,128,${b.pheromone*0.6})`; mCtx.lineWidth=1; mCtx.stroke(); }
    // hidden count
    const hiddenIn=prey.filter(p=>p.alive&&p.hidden&&p.bushIdx===bushes.indexOf(b)).length;
    if(hiddenIn){ mCtx.fillStyle='#eab308'; mCtx.beginPath(); mCtx.arc(cx,cy- r-5,4,0,Math.PI*2); mCtx.fill(); mCtx.fillStyle='#000'; mCtx.font='7px system-ui'; mCtx.fillText(String(hiddenIn), cx-3, cy- r-5 +2); }
    if(b.trampled){ mCtx.fillStyle='rgba(0,0,0,0.55)'; mCtx.font='8px system-ui'; mCtx.fillText('×', cx-3, cy+3); }
  }
  // pheromone dots
  for(const ph of pheromones){ const cx=wx(ph.x), cy=wy(ph.y); mCtx.fillStyle=`rgba(250,204,21,${ph.strength*0.55})`; mCtx.beginPath(); mCtx.arc(cx,cy,2.5,0,Math.PI*2); mCtx.fill(); }
  // prey
  for(let i=0;i<prey.length;i++){ const p=prey[i]; if(!p.alive) continue; const cx=wx(p.x), cy=wy(p.y); mCtx.fillStyle= p.hidden ? 'rgba(0,0,0,0)' : '#111827'; if(!p.hidden){ mCtx.beginPath(); mCtx.arc(cx,cy,3,0,Math.PI*2); mCtx.fill(); } }
  // bat
  const bx=wx(bat.x), by=wy(bat.y);
  mCtx.fillStyle='#6d28d9'; mCtx.beginPath(); mCtx.arc(bx,by,5,0,Math.PI*2); mCtx.fill();
  mCtx.strokeStyle='#fff'; mCtx.lineWidth=1.5; mCtx.stroke();
  // heading line
  mCtx.beginPath(); mCtx.moveTo(bx,by); mCtx.lineTo(bx+Math.cos(bat.heading)*10, by-Math.sin(bat.heading)*10); mCtx.strokeStyle='#6d28d9'; mCtx.lineWidth=1.2; mCtx.stroke();
  // border
  mCtx.strokeStyle='#cbd5e1'; mCtx.lineWidth=1.2; mCtx.strokeRect(pad,pad,Wm-pad*2,Hm-pad*2);
}

function loop(now){
  requestAnimationFrame(loop);
  const dt=Math.min(0.05,(now-last)/1000); last=now;
  if(playing){
    clock.advance(dt, fixed=>{
      tick(fixed);
      if(mode==='survival'){
        stamina -= fixed;
        timeLeft -= fixed;
        if(stamina<=0){ stamina=0; playing=false; setCursorState(); center.style.display='grid'; card.innerHTML=`<h1>Starved!</h1><p>Bat ran out of stamina — ate ${eaten}/${NUM_PREY} flies · Score ${score}</p><button id="again2">Try again</button>`; document.getElementById('again2').onclick=startSurvival; }
        else if(timeLeft<=0){ timeLeft=0; playing=false; setCursorState(); center.style.display='grid'; card.innerHTML=`<h1>Time!</h1><p>Ate ${eaten}/${NUM_PREY} flies · Score ${score}</p><button id="again2">Try again</button>`; document.getElementById('again2').onclick=startSurvival; }
        hudSurvival();
      } else {
        timeLeft -= fixed;
        if(timeLeft<=0){ timeLeft=0; playing=false; setCursorState(); center.style.display='grid'; card.innerHTML=`<h1>Time!</h1><p>Score ${score} · Level ${level}</p><button id="again2">Try again</button>`; document.getElementById('again2').onclick=startWhack; }
        hudWhack();
      }
    });
  } else {
    clock.advance(dt, fixed=>{ tick(fixed); });
    if(mode==='survival') hudSurvival(); else hudWhack();
  }
  updateBushes(dt);
  renderBrain();
  renderMiniMap();
  renderer.render(scene,camera);
}
if(mode==='survival'){ whackMesh.group.visible=false; hudSurvival(); } else { hudWhack(); }
resetWhack();
setCursorState();
requestAnimationFrame(loop);
