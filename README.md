# Bat vs Fly 🦇🪰

Whack-a-fly where your cursor **is** the bat. No clicking — the fly sees your loom and escapes using the real FlyWire 668-neuron brain + MaleCNS 1,045-neuron VNC.

- Fly brain in `data/` (FlyWire CC BY-NC 4.0, MaleCNS CC BY 4.0)
- Sim in `src/brain/` — port of `Sim.swift`/`Locomotor.swift` (LIF 1kHz, 120Hz fixed loop, 4ms inhibitory delay)
- Difficulty scales `tempo` / `loomGain` / `pNoise` + `walkDrive` so later levels are faster & more nervous

## Run
```sh
npm install
npm run dev   # http://localhost:5173
```

Tag the fly 10× before time runs out. Each level the fly gets faster.
