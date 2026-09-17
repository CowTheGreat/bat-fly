import * as THREE from 'three';
import { loadData } from './data.js';
import { LIFSim, SimulationClock } from './brain/sim.js';
import { SignalBuilder } from './brain/signals.js';

// Simple arena game: bat = cursor, fly = 3D fly driven by real spiking brain.
// Difficulty scales loomGain/tempo/noise so fly gets harder to swat.

const canvas = document.getElementById('c');
const batEl = document.getElementById('bat');
const lvEl = document.getElementById('lv'), diffEl = document.getElementById('diff');
const scEl = document.getElementById('sc'), hitsEl = document.getElementById('hits'), tmEl = document.getElementById('tm');
const card = document.getElementById('card'), playBtn = document.getElementById('play');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1,1,-1,1,0,100);
camera.position.set(0,0,10); camera.lookAt(0,0,0);

// arena bounds in world units (orthographic)
let W=800,H=600;
function resize(){
  W = window.innerWidth; H = window.innerHeight;
  renderer.setSize(W,H,false);
  const aspect = W/H;
  const view = 400;
  camera.left = -view*aspect; camera.right = view*aspect;
  camera.top = view; camera.bottom = -view;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();

// fly visual: icosahedron + wings
const flyGroup = new THREE.Group();
const body = new THREE.Mesh(new THREE.SphereGeometry(10,16,16), new THREE.MeshStandardMaterial({color:0x2b2b2b}));
body.scale.set(1,0.7,0.6);
const wingL = new THREE.Mesh(new THREE.PlaneGeometry(18,10), new THREE.MeshStandardMaterial({color:0xaad3ff, transparent:true, opacity:0.7, side:THREE.DoubleSide}));
const wingR = wingL.clone();
wingL.position.set(-10,0,0); wingR.position.set(10,0,0);
wingL.rotation.z = 0.3; wingR.rotation.z = -0.3;
flyGroup.add(body, wingL, wingR);
scene.add(flyGroup);
const light = new THREE.DirectionalLight(0xffffff, 1.2); light.position.set(200,300,200); scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

// bat cursor
let bat = { x:0, y:0, vx:0, vy:0, px:0, py:0 };
let mouse = { x:0, y:0 };
window.addEventListener('mousemove', e=>{
  mouse.x = ((e.clientX / W)*2 -1) * (camera.right);
  mouse.y = -((e.clientY / H)*2 -1) * (camera.top);
  batEl.style.left = e.clientX+'px'; batEl.style.top = e.clientY+'px';
});
window.addEventListener('touchmove', e=>{
  const t=e.touches[0]; if(!t) return;
  mouse.x = ((t.clientX / W)*2 -1) * (camera.right);
  mouse.y = -((t.clientY / H)*2 -1) * (camera.top);
  batEl.style.left = t.clientX+'px'; batEl.style.top = t.clientY+'px';
}, {passive:true});

// load brain
const { circuit, locomotor } = await loadData();
const sim = new LIFSim(circuit, null, locomotor);
const signals = new SignalBuilder();
const clock = new SimulationClock();

// fly state
let fly = { x:0, y:0, vx: 60, vy: 40, heading: 0, wingPhase: 0 };
let score=0, hits=0, hitsNeeded=10, level=1, timeLeft=30, playing=false, last=performance.now();

function difficultyFor(level){
  // Easy -> hard: tempo, loomGain, pNoise, walkDrive scaling
  const d = Math.min(5, level);
  return {
    label: ['easy','medium','hard','insane','nightmare'][d-1],
    tempo: 0.8 + d*0.18,           // 0.98 .. 1.7
    loomGainScale: 0.7 + d*0.25,   // 0.95 .. 1.95  -> multiplied with sim.loomGain inside step
    pNoiseScale: 0.7 + d*0.3,      // via activityScale
    speed: 70 + d*28,             // base walk speed
  };
}
let diff = difficultyFor(1);
function applyDifficulty(){
  diff = difficultyFor(level);
  diffEl.textContent = diff.label;
  lvEl.textContent = level;
}

function resetFly(){
  fly.x = (Math.random()*0.6-0.3)*(camera.right - camera.left);
  fly.y = (Math.random()*0.6-0.3)*(camera.top - camera.bottom);
  fly.vx = (Math.random()<0.5?1:-1)*diff.speed*0.6;
  fly.vy = (Math.random()<0.5?1:-1)*diff.speed*0.6;
}

function setHUD(){ scEl.textContent=score; hitsEl.textContent=`${hits}/${hitsNeeded}`; tmEl.textContent=timeLeft.toFixed(1); }

function start(){
  score=0; hits=0; level=1; timeLeft=30; playing=true;
  applyDifficulty(); resetFly(); setHUD();
  card.parentElement.style.display='none';
  last=performance.now();
}
function nextLevel(){
  level++; timeLeft = Math.max(12, 30 - (level-1)*3.5);
  applyDifficulty(); setHUD();
}

playBtn.onclick = start;

// main tick: senses = bat loom -> brain -> movement
function tick(dt){
  // bat velocity for loom intensity
  bat.vx = (mouse.x - bat.px)/Math.max(0.001, dt);
  bat.vy = (mouse.y - bat.py)/Math.max(0.001, dt);
  bat.px = mouse.x; bat.py = mouse.y;
  bat.x = mouse.x; bat.y = mouse.y;

  const dx = bat.x - fly.x, dy = bat.y - fly.y;
  const dist = Math.hypot(dx,dy);
  const speed = Math.hypot(bat.vx, bat.vy);
  // looming stimulus split by bearing (like windows port)
  const bearing = Math.atan2(dy,dx) - fly.heading;
  const leftFactor = bearing > 0 ? 1 : 0.2;
  const rightFactor = bearing <= 0 ? 1 : 0.2;
  // loom 0..1: closer + faster = stronger. Scale by difficulty.
  const loomBase = Math.max(0, 1 - dist/260) * Math.min(1, speed/900 + 0.25) * (dist<120?1.4:1);
  const loom = Math.min(1, loomBase * diff.loomGainScale);
  sim.loomL = loom * leftFactor;
  sim.loomR = loom * rightFactor;
  sim.airPuff = dist < 140 ? Math.min(1, (1.2 - dist/140) * 0.9) : 0;
  sim.activityScale = diff.pNoiseScale * diff.tempo;
  sim.sensoryGate = 1;

  // advance brain: sim wants ms
  const ms = Math.max(1, Math.round(dt*1000));
  sim.step(ms);
  const s = signals.make(sim, dt);

  // map brain to velocity
  // walkDrive 0..1.3, nervous 0..1, turnBias -1..1, escape bool
  let wantSpeed = diff.speed * (0.5 + s.walkDrive*0.9 + s.nervous*0.6) * diff.tempo;
  if(s.escape){
    // explosive escape: dash away from bat
    const ang = Math.atan2(fly.y - bat.y, fly.x - bat.x);
    fly.vx = Math.cos(ang)* (wantSpeed*2.2 + 180);
    fly.vy = Math.sin(ang)* (wantSpeed*2.2 + 180);
    // consume latch is done inside signals.make
  } else {
    const steer = s.turnBias * 3.5; // rad/s
    fly.heading += steer * dt;
    // nervous darting: jitter heading
    if(s.nervous > 0.35) fly.heading += (Math.random()-0.5)* s.nervous * 6 * dt;
    // forward
    const h = fly.heading;
    fly.vx += (Math.cos(h)*wantSpeed - fly.vx) * Math.min(1, 4*dt);
    fly.vy += (Math.sin(h)*wantSpeed - fly.vy) * Math.min(1, 4*dt);
  }

  // walls
  const L=camera.left+18, R=camera.right-18, B=camera.bottom+18, T=camera.top-18;
  if(fly.x<L){ fly.x=L; fly.vx=Math.abs(fly.vx); fly.heading=0; }
  if(fly.x>R){ fly.x=R; fly.vx=-Math.abs(fly.vx); fly.heading=Math.PI; }
  if(fly.y<B){ fly.y=B; fly.vy=Math.abs(fly.vy); }
  if(fly.y>T){ fly.y=T; fly.vy=-Math.abs(fly.vy); }

  fly.x += fly.vx * dt; fly.y += fly.vy * dt;
  fly.heading = Math.atan2(fly.vy, fly.vx);
  flyGroup.position.set(fly.x, fly.y, 0);
  flyGroup.rotation.z = fly.heading;

  // wing beat
  fly.wingPhase += dt * 28 * (0.8 + s.wingDrive*1.2);
  wingL.rotation.z = 0.28 + Math.sin(fly.wingPhase)*0.9;
  wingR.rotation.z = -0.28 - Math.sin(fly.wingPhase)*0.9;

  // hit test: bat circle vs fly
  if(playing && dist < 28){
    hits++; score += 100 * level;
    // kick fly away
    const ang = Math.atan2(fly.y - bat.y, fly.x - bat.x) || Math.random()*6.28;
    fly.vx = Math.cos(ang)*320; fly.vy = Math.sin(ang)*320;
    fly.x += Math.cos(ang)*18; fly.y += Math.sin(ang)*18;
    // brief flash
    body.material.emissive = new THREE.Color(0x66aaff); setTimeout(()=> body.material.emissive.setHex(0), 120);
    setHUD();
    if(hits >= hitsNeeded){
      if(level >= 5){ // win
        playing=false; card.innerHTML=`<h1>You win! 🏆</h1><p>Score ${score} — you swatted a real brain.</p><button id="again">Play again</button>`; card.parentElement.style.display='grid'; document.getElementById('again').onclick=start;
      } else { hits=0; nextLevel(); }
    }
  }
}

function loop(now){
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last)/1000); last = now;
  if(playing){
    // fixed 120Hz like Sim.swift so brain is framerate independent
    clock.advance(dt, fixed=>{
      tick(fixed);
      timeLeft -= fixed;
      if(timeLeft<=0){ timeLeft=0; playing=false; card.innerHTML=`<h1>Time!</h1><p>Score ${score} · Level ${level}</p><button id="again2">Try again</button>`; card.parentElement.style.display='grid'; document.getElementById('again2').onclick=start; }
      setHUD();
    });
  } else {
    // still animate idle fly/brain
    clock.advance(dt, fixed=> tick(fixed));
  }
  renderer.render(scene,camera);
}
resetFly(); applyDifficulty(); setHUD(); requestAnimationFrame(loop);
