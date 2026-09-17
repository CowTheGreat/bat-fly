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
  // scale
  const s = isBat ? 1.45 : 0.88;
  g.scale.set(s*1.15, s*1.15, s*1.15); // buildFlyModel already has FLY_SCALE 1.15, so multiply
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
    // enlarge wings slightly for bat
    m.foldedWings.scale.set(1.25,1.25,1.25);
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

// Game state
let mode = 'survival'; // 'survival' | 'whack'
const NUM_PREY = 12, TOTAL_TIME = 60, STAMINA_MAX = 10;
const BAT_INITIAL_STAMINA = 10; // 10s per fly as requested — no extra grace needed now
let bat = { x:0,y:0,vx:0,vy:0,heading:0,wingPhase:0, speed:0 };
let prey = []; // {x,y,vx,vy,heading,wingPhase,alive, mesh}
let batMesh, preyMeshes=[];
let score=0, eaten=0, timeLeft=TOTAL_TIME, stamina=STAMINA_MAX, playing=false, last=performance.now();
let hits=0, hitsNeeded=10, level=1; // for whack mode
let mouse = {x:0,y:0, px:0,py:0, vx:0, vy:0};
let diff = { label:'easy', tempo:1, loomGainScale:1, pNoiseScale:1, speed:80 };

function difficultyFor(lv){
  const d=Math.min(5,lv);
  return { label:['easy','medium','hard','insane','nightmare'][d-1], tempo:0.8+d*0.18, loomGainScale:0.7+d*0.25, pNoiseScale:0.7+d*0.3, speed:70+d*28 };
}
function applyDiff(){ diff=difficultyFor(level); }

function resetWhackFly(f){ f.x=(Math.random()*0.6-0.3)*(camera.right-camera.left); f.y=(Math.random()*0.6-0.3)*(camera.top-camera.bottom); f.vx=(Math.random()<0.5?1:-1)*diff.speed*0.6; f.vy=(Math.random()<0.5?1:-1)*diff.speed*0.6; }

// survival setup
function clearCreatures(){
  for(const m of preyMeshes) scene.remove(m.group);
  if(batMesh) scene.remove(batMesh.group);
  preyMeshes=[]; batMesh=null; prey=[];
}
function spawnSurvival(){
  clearCreatures();
  batMesh = makeCreature(true);
  // bat start near center
  bat = { x:(Math.random()-0.5)*100, y:(Math.random()-0.5)*100, vx:0, vy:0, heading: Math.random()*Math.PI*2, wingPhase:0, speed:0 };
  batMesh.group.position.set(bat.x,bat.y,0);
  prey=[];
  preyMeshes=[];
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
    prey.push({x,y,vx:0,vy:0,heading,wingPhase:Math.random()*6, alive:true});
    preyMeshes.push(m);
  }
  eaten=0; score=0; timeLeft=TOTAL_TIME; stamina=BAT_INITIAL_STAMINA;
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
  fliesEl.textContent=`${eaten}/${NUM_PREY}`;
  diffEl.textContent=`stamina ${stamina.toFixed(1)}s`;
  diffEl.style.background = stamina<3 ? '#3a1a1a' : '#1e2a44';
  scEl.textContent=score;
  tmEl.textContent=timeLeft.toFixed(1);
  const pct = Math.max(0, Math.min(1, stamina/STAMINA_MAX))*100;
  staminaBar.style.width = pct+'%';
  staminaBar.classList.toggle('low', stamina<3);
  // aggression HUD — grows as time runs out
  const timeFrac = 1 - timeLeft/TOTAL_TIME;
  const aggr = Math.min(100, timeFrac*100);
  if(aggressionFill) aggressionFill.style.width = aggr.toFixed(1)+'%';
  // background goes aggressive after 60% time
  gameEl.classList.toggle('aggressive', timeFrac > 0.55);
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
  clearCreatures();
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
    card.innerHTML = `<h1>Bat vs Fly — Survival 🦇</h1><p><b>One fly mutates into a bat.</b> 12 flies remain. The bat's <em>real 668-neuron brain</em> drives it — watch on the right.</p><p style="font-size:13px;opacity:0.9">Eat <b>all 12 flies</b> in <b>60s</b>. Each fly = <b>+10s stamina</b>.</p><button id="play">Transform &amp; Hunt</button><p style="margin-top:10px;font-size:11px;opacity:.6">Brain: LIF 668 neurons · Prey flee · Stamina 10s · Predator AI</p>`;
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

// Survival tick
function nearestPrey(){
  let best=null, bestD=Infinity, bestI=-1;
  for(let i=0;i<prey.length;i++){ if(!prey[i].alive) continue; const d=Math.hypot(prey[i].x-bat.x, prey[i].y-bat.y); if(d<bestD){bestD=d; best=prey[i]; bestI=i;}}
  return { prey:best, dist:bestD, idx:bestI };
}
function tickSurvival(dt){
  const np = nearestPrey();
  const target = np.prey;
  let loomL=0, loomR=0, air=0;
  let huntAngle = bat.heading;
  // predictive intercept — lead the prey based on its velocity
  let predX = target ? target.x : 0, predY = target ? target.y : 0;
  if(target){
    const lead = Math.min(0.35, np.dist / 700); // ~0.15-0.35s ahead
    predX = target.x + (target.vx||0)*lead;
    predY = target.y + (target.vy||0)*lead;
    // clamp predicted point inside arena
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
  }
  // stamina + time modulate brain — aggressive as clock runs down
  const stamFrac = Math.max(0.35, stamina/STAMINA_MAX);
  const timeFrac = Math.max(0, Math.min(1, 1 - timeLeft/TOTAL_TIME)); // 0 calm →1 frenzy
  const aggression = 1 + timeFrac*0.95 + (stamina<4 ? (4-stamina)/4*0.45 : 0); // 1.0 → ~2.1
  sim.loomL=loomL; sim.loomR=loomR; sim.airPuff=air;
  sim.activityScale = (0.95 * stamFrac + 0.65) + timeFrac*0.50; // noisier = more nervous when desperate
  sim.sensoryGate = 1;
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

  // prey update: flee from bat — SLOWER than bat so bat can catch
  for(let i=0;i<prey.length;i++){
    const p=prey[i]; if(!p.alive) continue;
    const m=preyMeshes[i];
    const dx=p.x-bat.x, dy=p.y-bat.y, d=Math.hypot(dx,dy);
    if(d<150){
      // flee — reduced speed (prey is food, not elite)
      const away=Math.atan2(dy,dx);
      const fleeSpeed=95 + (150-d)*0.45 + Math.random()*14;
      p.heading += (away - p.heading)*Math.min(1, 4.5*dt);
      p.heading += (Math.random()-0.5)*0.5*dt;
      p.vx = Math.cos(p.heading)*fleeSpeed;
      p.vy = Math.sin(p.heading)*fleeSpeed;
    } else {
      // wander
      p.heading += (Math.random()-0.5)*1.2*dt;
      const wanderSpd = 38 + Math.random()*16;
      p.vx += (Math.cos(p.heading)*wanderSpd - p.vx)*Math.min(1,2.5*dt);
      p.vy += (Math.sin(p.heading)*wanderSpd - p.vy)*Math.min(1,2.5*dt);
    }
    // wall
    if(p.x<Ls){ p.x=Ls; p.vx=Math.abs(p.vx); p.heading=0; }
    if(p.x>Rs){ p.x=Rs; p.vx=-Math.abs(p.vx); p.heading=Math.PI; }
    if(p.y<Bs){ p.y=Bs; p.vy=Math.abs(p.vy); }
    if(p.y>Ts){ p.y=Ts; p.vy=-Math.abs(p.vy); }
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
  // eat check — larger radius for big bat
  for(let i=0;i<prey.length;i++){
    const p=prey[i]; if(!p.alive) continue;
    const d=Math.hypot(p.x-bat.x, p.y-bat.y);
    if(d<34){
      p.alive=false; preyMeshes[i].group.visible=false;
      // pop effect: flash bat (traverse for detailed model)
      flashCreature(batMesh, 0x33ff88, 180);
      eaten++; score+=150;
      stamina = STAMINA_MAX; // +10s
      // small kick prey away? already eaten
      if(eaten>=NUM_PREY){
        playing=false; setCursorState();
        center.style.display='grid';
        card.innerHTML=`<h1>Hunt complete! 🏆</h1><p>Ate all ${NUM_PREY} flies in ${(TOTAL_TIME-timeLeft).toFixed(1)}s · Score ${score}</p><p style="font-size:12px;opacity:0.7">Bat brain drove every turn — 668 neurons, GF escapes, DNa steering.</p><button id="again">Hunt again</button> <button class="secondary" id="whackBtn">Whack mode</button>`;
        document.getElementById('again').onclick=startSurvival;
        const wb=document.getElementById('whackBtn'); if(wb) wb.onclick=()=>{mode='whack'; modeBtn.textContent='Mode: Whack'; startWhack();};
      }
      break; // one per tick
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
  // overlay: total spikes text
  bCtx.fillStyle='rgba(255,255,255,0.7)';
  bCtx.font='10px system-ui';
  bCtx.fillText(`sim ${now} ms · ${n} neurons`, 8, Hb-8);
}

function loop(now){
  requestAnimationFrame(loop);
  const dt=Math.min(0.05,(now-last)/1000); last=now;
  if(playing){
    clock.advance(dt, fixed=>{
      tick(fixed);
      if(mode==='survival'){
        stamina -= fixed; // 1:1 — 10s really is 10s
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
  renderBrain();
  renderer.render(scene,camera);
}
if(mode==='survival'){ whackMesh.group.visible=false; hudSurvival(); } else { hudWhack(); }
resetWhack();
setCursorState();
requestAnimationFrame(loop);
