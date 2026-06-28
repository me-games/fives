import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import './style.css'

type Team = 'blue' | 'red'
type Phase = 'kickoff' | 'playing' | 'finished'
type SoundId = 'kick' | 'goal' | 'whistle' | 'music'

interface Footballer {
  team: Team
  number: number
  controlled: boolean
  group: THREE.Group
  body: THREE.Mesh
  leftLeg: THREE.Mesh
  rightLeg: THREE.Mesh
  selector: THREE.Mesh
  fallbackGroup: THREE.Group
  visualModel?: THREE.Object3D
  home: THREE.Vector3
  target: THREE.Vector3
  velocity: THREE.Vector3
  kickCooldown: number
  legPhase: number
}

const FIELD_LENGTH = 82
const FIELD_WIDTH = 52
const GOAL_WIDTH = 14
const GOAL_DEPTH = 4.5
const GOAL_HEIGHT = 4
const PLAYER_RADIUS = 0.85
const BALL_RADIUS = 0.58
const MAX_ROUNDS = 5
const ROUND_SECONDS = 45
const DEBUG_SEED = 3405
const ASSETS = {
  ballModel: './assets/models/classic-black-and-white-size-five-football-soccer.glb',
  bluePlayerModel: './assets/models/stylized-five-a-side-football-player-in-blue-kit-g.glb',
  redPlayerModel: './assets/models/stylized-five-a-side-football-player-in-red-kit-ga.glb',
  fanModel: './assets/models/stylized-football-fan-spectator-cheering-colorful.glb',
  treeModel: './assets/models/lush-leafy-stadium-park-tree-broad-canopy-game-rea.glb',
  stadiumSkybox: './assets/skybox/sunny-afternoon-five-a-side-football-pitch-park-st.jpg',
  turfTexture: './assets/textures/short-cut-green-five-a-side-football-turf-with-sub/basecolor.png',
  kickSfx: './assets/sfx/clean-football-kick-thump-short-dry-leather-impact.mp3',
  goalSfx: './assets/sfx/small-five-a-side-stadium-crowd-cheer-after-a-goal.mp3',
  whistleSfx: './assets/sfx/referee-whistle-for-kickoff-and-round-end-crisp-sp.mp3',
  musicSfx: './assets/sfx/loopable-upbeat-arcade-football-stadium-background.mp3',
}

const teamDirection: Record<Team, number> = {
  blue: 1,
  red: -1,
}

function queryRequired<T extends Element>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Missing required element: ${selector}`)
  }
  return element
}

const app = queryRequired<HTMLDivElement>('#app')

app.innerHTML = `
  <canvas id="game" aria-label="Fives football game"></canvas>
  <div class="hud" aria-live="polite">
    <div class="scoreboard">
      <div class="team team-blue">Blue</div>
      <div class="score" id="blue-score">0</div>
      <div class="score-dash">:</div>
      <div class="score" id="red-score">0</div>
      <div class="team team-red">Red</div>
    </div>
    <div class="roundline">
      <span id="round-label">Round 1/5</span>
      <span id="clock">45.0</span>
    </div>
  </div>
  <div class="status" id="status">Kickoff</div>
  <button class="restart" id="restart" type="button" hidden>Play Again</button>
`

const canvas = queryRequired<HTMLCanvasElement>('#game')
const blueScoreEl = queryRequired<HTMLDivElement>('#blue-score')
const redScoreEl = queryRequired<HTMLDivElement>('#red-score')
const roundLabelEl = queryRequired<HTMLSpanElement>('#round-label')
const clockEl = queryRequired<HTMLSpanElement>('#clock')
const statusEl = queryRequired<HTMLDivElement>('#status')
const restartEl = queryRequired<HTMLButtonElement>('#restart')

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x93c9ff)
scene.fog = new THREE.Fog(0x93c9ff, 65, 145)

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 260)
camera.position.set(-17, 17, 20)

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap

const timer = new THREE.Timer()
timer.connect(document)

const audioListener = new THREE.AudioListener()
camera.add(audioListener)

const textureLoader = new THREE.TextureLoader()
const gltfLoader = new GLTFLoader()
const audioLoader = new THREE.AudioLoader()
const soundBuffers: Partial<Record<SoundId, AudioBuffer>> = {}
const activeSounds = new Set<THREE.Audio>()
let backgroundMusic: THREE.Audio | null = null
const cameraLookTarget = new THREE.Vector3()
const desiredCameraPosition = new THREE.Vector3()
const desiredLookTarget = new THREE.Vector3()
const raycaster = new THREE.Raycaster()
const pointerPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const pointerTarget = new THREE.Vector3()
const pointerNdc = new THREE.Vector2()
const tempVector = new THREE.Vector3()
const tempVector2 = new THREE.Vector3()

const keys = new Set<string>()
let pointerActive = false
let pointerHasTarget = false
let kickRequested = false
let debugView = false

const state = {
  phase: 'kickoff' as Phase,
  blueScore: 0,
  redScore: 0,
  round: 1,
  timeLeft: ROUND_SECONDS,
  kickoffTimer: 1.4,
}

const materials = {
  field: new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.92 }),
  fieldStripe: new THREE.MeshStandardMaterial({ color: 0x379444, roughness: 0.94 }),
  fieldDark: new THREE.MeshStandardMaterial({ color: 0x1d5f2e, roughness: 0.96 }),
  line: new THREE.MeshStandardMaterial({ color: 0xf3f7ef, roughness: 0.7 }),
  blue: new THREE.MeshStandardMaterial({ color: 0x1d5dff, roughness: 0.48, metalness: 0.02 }),
  blueTrim: new THREE.MeshStandardMaterial({ color: 0xb8d4ff, roughness: 0.58 }),
  red: new THREE.MeshStandardMaterial({ color: 0xd92d2d, roughness: 0.5, metalness: 0.02 }),
  redTrim: new THREE.MeshStandardMaterial({ color: 0xffc6bc, roughness: 0.6 }),
  skin: new THREE.MeshStandardMaterial({ color: 0xd9a26f, roughness: 0.64 }),
  black: new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.62 }),
  ball: new THREE.MeshStandardMaterial({ color: 0xf8f8ee, roughness: 0.43 }),
  ballInk: new THREE.MeshStandardMaterial({ color: 0x181a1f, roughness: 0.58 }),
  goal: new THREE.MeshStandardMaterial({ color: 0xf7f7f2, roughness: 0.42 }),
  net: new THREE.LineBasicMaterial({ color: 0xdce8ef, transparent: true, opacity: 0.46 }),
  selector: new THREE.MeshBasicMaterial({ color: 0xf7d348, transparent: true, opacity: 0.86 }),
  stand: new THREE.MeshStandardMaterial({ color: 0x3a3e45, roughness: 0.78 }),
  seatBlue: new THREE.MeshStandardMaterial({ color: 0x236bd7, roughness: 0.8 }),
  seatRed: new THREE.MeshStandardMaterial({ color: 0xbf3e3e, roughness: 0.8 }),
  seatLight: new THREE.MeshStandardMaterial({ color: 0xe2e7e8, roughness: 0.82 }),
  audienceBlue: new THREE.MeshStandardMaterial({ color: 0x2d7de0, roughness: 0.7 }),
  audienceRed: new THREE.MeshStandardMaterial({ color: 0xd7493d, roughness: 0.72 }),
  audienceYellow: new THREE.MeshStandardMaterial({ color: 0xe7c840, roughness: 0.72 }),
  audienceWhite: new THREE.MeshStandardMaterial({ color: 0xe9eef0, roughness: 0.74 }),
  treeTrunk: new THREE.MeshStandardMaterial({ color: 0x6f4a2e, roughness: 0.88 }),
  treeLeaf: new THREE.MeshStandardMaterial({ color: 0x2f8a45, roughness: 0.92 }),
  treeLeafDark: new THREE.MeshStandardMaterial({ color: 0x1f6e39, roughness: 0.94 }),
  shadowOnly: new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.2 }),
}

function unlockAudio() {
  if (audioListener.context.state === 'suspended') {
    void audioListener.context.resume().then(startBackgroundMusic)
  } else {
    startBackgroundMusic()
  }
}

function loadSound(id: SoundId, path: string) {
  audioLoader.load(
    path,
    (buffer) => {
      soundBuffers[id] = buffer
      if (id === 'music') {
        startBackgroundMusic()
      }
    },
    undefined,
    (error) => {
      console.warn(`Could not load ${id} sound`, error)
    },
  )
}

function startBackgroundMusic() {
  const buffer = soundBuffers.music
  if (!buffer || audioListener.context.state !== 'running') {
    return
  }

  if (!backgroundMusic) {
    backgroundMusic = new THREE.Audio(audioListener)
    backgroundMusic.setBuffer(buffer)
    backgroundMusic.setLoop(true)
    backgroundMusic.setVolume(0.22)
  }

  if (!backgroundMusic.isPlaying) {
    backgroundMusic.play()
  }
}

function playSound(id: SoundId, volume = 0.75) {
  const buffer = soundBuffers[id]
  if (!buffer || audioListener.context.state !== 'running') {
    return
  }

  const sound = new THREE.Audio(audioListener)
  const defaultOnEnded = sound.onEnded.bind(sound)
  sound.onEnded = () => {
    defaultOnEnded()
    sound.disconnect()
    activeSounds.delete(sound)
  }
  sound.setBuffer(buffer)
  sound.setVolume(volume)
  activeSounds.add(sound)
  sound.play()
}

function loadTurfTexture() {
  textureLoader.load(
    ASSETS.turfTexture,
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace
      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.RepeatWrapping
      texture.repeat.set(18, 12)
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy()

      const stripeTexture = texture.clone()
      stripeTexture.needsUpdate = true

      materials.field.map = texture
      materials.field.color.set(0xffffff)
      materials.field.needsUpdate = true
      materials.fieldStripe.map = stripeTexture
      materials.fieldStripe.color.set(0xd7f3d0)
      materials.fieldStripe.needsUpdate = true
    },
    undefined,
    (error) => {
      console.warn('Could not load generated turf texture', error)
    },
  )
}

function loadBallModel() {
  gltfLoader.load(
    ASSETS.ballModel,
    (gltf) => {
      const model = gltf.scene
      model.traverse((child: THREE.Object3D) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true
          child.receiveShadow = false
        }
      })

      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3())
      const maxDimension = Math.max(size.x, size.y, size.z)
      if (maxDimension > 0) {
        model.scale.setScalar((BALL_RADIUS * 2) / maxDimension)
        model.updateWorldMatrix(true, true)
        box.setFromObject(model)
        const center = box.getCenter(new THREE.Vector3())
        model.position.sub(center)
      }

      ball.clear()
      ball.add(model)
    },
    undefined,
    (error) => {
      console.warn('Could not load generated football model', error)
    },
  )
}

function normalizeModel(model: THREE.Object3D, targetHeight: number) {
  model.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const height = Math.max(size.y, 0.001)
  model.scale.multiplyScalar(targetHeight / height)
  model.updateWorldMatrix(true, true)
  box.setFromObject(model)
  const center = box.getCenter(new THREE.Vector3())
  const minY = box.min.y
  model.position.x -= center.x
  model.position.y -= minY
  model.position.z -= center.z
  model.updateWorldMatrix(true, true)
  return model
}

function prepareGeneratedModel(model: THREE.Object3D, targetHeight: number) {
  normalizeModel(model, targetHeight)
  model.traverse((child: THREE.Object3D) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true
      child.receiveShadow = true
    }
  })
  return model
}

function applyPlayerModel(player: Footballer, source: THREE.Object3D) {
  if (player.visualModel) {
    player.group.remove(player.visualModel)
  }

  const model = cloneSkeleton(source)
  model.rotation.y = Math.PI
  model.position.y = 0
  model.scale.multiplyScalar(player.controlled ? 1.04 : 1)
  player.fallbackGroup.visible = false
  player.visualModel = model
  player.group.add(model)
}

function loadPlayerModels() {
  gltfLoader.load(
    ASSETS.bluePlayerModel,
    (gltf) => {
      const model = prepareGeneratedModel(gltf.scene, 2.65)
      for (const player of bluePlayers) {
        applyPlayerModel(player, model)
      }
    },
    undefined,
    (error) => {
      console.warn('Could not load generated blue player model', error)
    },
  )

  gltfLoader.load(
    ASSETS.redPlayerModel,
    (gltf) => {
      const model = prepareGeneratedModel(gltf.scene, 2.65)
      for (const player of redPlayers) {
        applyPlayerModel(player, model)
      }
    },
    undefined,
    (error) => {
      console.warn('Could not load generated red player model', error)
    },
  )
}

function loadSkybox() {
  textureLoader.load(
    ASSETS.stadiumSkybox,
    (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping
      texture.colorSpace = THREE.SRGBColorSpace
      scene.background = texture
      scene.environment = new THREE.PMREMGenerator(renderer).fromEquirectangular(texture).texture
      renderer.toneMappingExposure = 1.05
    },
    undefined,
    (error) => {
      console.warn('Could not load generated stadium skybox', error)
    },
  )
}

function loadGeneratedAudience() {
  gltfLoader.load(
    ASSETS.fanModel,
    (gltf) => {
      const model = prepareGeneratedModel(gltf.scene, 1.35)
      generatedAudienceGroup.clear()

      audiencePlacements.forEach((placement, index) => {
        if (index % 13 !== 0) {
          return
        }

        const fan = cloneSkeleton(model)
        fan.position.copy(placement.position)
        fan.position.y -= 0.08
        fan.rotation.y = placement.rotationY + Math.PI
        fan.scale.setScalar(placement.scale * (0.9 + (index % 5) * 0.035))
        generatedAudienceGroup.add(fan)
      })
    },
    undefined,
    (error) => {
      console.warn('Could not load generated spectator model', error)
    },
  )
}

function loadGeneratedTrees() {
  gltfLoader.load(
    ASSETS.treeModel,
    (gltf) => {
      const model = prepareGeneratedModel(gltf.scene, 5.9)
      generatedTreeGroup.clear()

      treePlacements.forEach((placement, index) => {
        if (index % 3 !== 0) {
          return
        }

        const tree = cloneSkeleton(model)
        tree.position.copy(placement.position)
        tree.rotation.y = placement.rotationY
        tree.scale.setScalar(placement.scale * (0.86 + (index % 4) * 0.08))
        generatedTreeGroup.add(tree)
      })
    },
    undefined,
    (error) => {
      console.warn('Could not load generated tree model', error)
    },
  )
}

function loadGameAssets() {
  loadSkybox()
  loadTurfTexture()
  loadBallModel()
  loadPlayerModels()
  loadGeneratedAudience()
  loadGeneratedTrees()
  loadSound('kick', ASSETS.kickSfx)
  loadSound('goal', ASSETS.goalSfx)
  loadSound('whistle', ASSETS.whistleSfx)
  loadSound('music', ASSETS.musicSfx)
}

const fieldGroup = new THREE.Group()
const audienceGroup = new THREE.Group()
const generatedAudienceGroup = new THREE.Group()
const treeGroup = new THREE.Group()
const generatedTreeGroup = new THREE.Group()
const players: Footballer[] = []
const bluePlayers: Footballer[] = []
const redPlayers: Footballer[] = []

const ball = new THREE.Group()
const ballVelocity = new THREE.Vector3()
const fieldBounds = new THREE.Box3(
  new THREE.Vector3(-FIELD_LENGTH / 2, -0.1, -FIELD_WIDTH / 2),
  new THREE.Vector3(FIELD_LENGTH / 2, 5, FIELD_WIDTH / 2),
)

function dampAlpha(rate: number, deltaTime: number) {
  return 1 - Math.exp(-rate * deltaTime)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function seededRandom(seed: number) {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let next = value
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

const random = seededRandom(DEBUG_SEED)

interface Placement {
  position: THREE.Vector3
  rotationY: number
  scale: number
  variant: number
}

const audiencePlacements: Placement[] = []
const treePlacements: Placement[] = []

function makePlacement(x: number, y: number, z: number, rotationY: number, scale: number, variant: number): Placement {
  return {
    position: new THREE.Vector3(x, y, z),
    rotationY,
    scale,
    variant,
  }
}

function buildInstancedPeople(placements: Placement[]) {
  const bodyGeometry = new THREE.CapsuleGeometry(0.19, 0.52, 4, 8)
  const headGeometry = new THREE.SphereGeometry(0.15, 10, 8)
  const bodyMaterials = [materials.audienceBlue, materials.audienceRed, materials.audienceYellow, materials.audienceWhite]
  const byVariant = bodyMaterials.map(() => [] as Placement[])

  for (const placement of placements) {
    byVariant[placement.variant % byVariant.length].push(placement)
  }

  const dummy = new THREE.Object3D()

  byVariant.forEach((variantPlacements, index) => {
    const mesh = new THREE.InstancedMesh(bodyGeometry, bodyMaterials[index], variantPlacements.length)
    mesh.castShadow = true
    mesh.receiveShadow = false

    variantPlacements.forEach((placement, instanceIndex) => {
      dummy.position.copy(placement.position)
      dummy.position.y += 0.45 * placement.scale
      dummy.rotation.set(0, placement.rotationY, 0)
      dummy.scale.setScalar(placement.scale)
      dummy.updateMatrix()
      mesh.setMatrixAt(instanceIndex, dummy.matrix)
    })

    mesh.instanceMatrix.needsUpdate = true
    audienceGroup.add(mesh)
  })

  const heads = new THREE.InstancedMesh(headGeometry, materials.skin, placements.length)
  heads.castShadow = true

  placements.forEach((placement, index) => {
    dummy.position.copy(placement.position)
    dummy.position.y += 1.0 * placement.scale
    dummy.rotation.set(0, placement.rotationY, 0)
    dummy.scale.setScalar(placement.scale)
    dummy.updateMatrix()
    heads.setMatrixAt(index, dummy.matrix)
  })

  heads.instanceMatrix.needsUpdate = true
  audienceGroup.add(heads)
}

function addSideAudiencePlacements() {
  const columns = 58
  const rows = 5

  for (const side of [-1, 1]) {
    const rotationY = side > 0 ? Math.PI : 0

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if ((column + row) % 9 === 0 && row > 2) {
          continue
        }

        const rowNoise = random() - 0.5
        const x = -FIELD_LENGTH / 2 - 8 + column * ((FIELD_LENGTH + 16) / (columns - 1)) + rowNoise * 0.28
        const z = side * (FIELD_WIDTH / 2 + 5.45 + row * 2.18 + (random() - 0.5) * 0.28)
        const y = 0.9 + row * 0.58
        const scale = 0.78 + random() * 0.22
        audiencePlacements.push(makePlacement(x, y, z, rotationY, scale, column + row * 3 + (side > 0 ? 2 : 0)))
      }
    }
  }
}

function addEndAudiencePlacements() {
  const columns = 22
  const rows = 4

  for (const end of [-1, 1]) {
    const rotationY = end > 0 ? -Math.PI / 2 : Math.PI / 2

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if ((column + row) % 8 === 0) {
          continue
        }

        const x = end * (FIELD_LENGTH / 2 + 6 + row * 2.1 + (random() - 0.5) * 0.25)
        const z = -FIELD_WIDTH / 2 + 5 + column * ((FIELD_WIDTH - 10) / (columns - 1)) + (random() - 0.5) * 0.22
        const y = 0.75 + row * 0.52
        const scale = 0.72 + random() * 0.2
        audiencePlacements.push(makePlacement(x, y, z, rotationY, scale, column + row * 5 + (end > 0 ? 1 : 3)))
      }
    }
  }
}

function buildAudience() {
  audienceGroup.name = 'extensive-audience-system'
  generatedAudienceGroup.name = 'generated-featured-fans'
  audiencePlacements.length = 0
  audienceGroup.clear()
  generatedAudienceGroup.clear()

  addSideAudiencePlacements()
  addEndAudiencePlacements()
  buildInstancedPeople(audiencePlacements)
  audienceGroup.add(generatedAudienceGroup)
  scene.add(audienceGroup)
}

function buildInstancedTrees(placements: Placement[]) {
  const trunkGeometry = new THREE.CylinderGeometry(0.18, 0.28, 2.4, 7)
  const canopyGeometry = new THREE.IcosahedronGeometry(1.45, 1)
  const dummy = new THREE.Object3D()

  const trunks = new THREE.InstancedMesh(trunkGeometry, materials.treeTrunk, placements.length)
  const leaves = new THREE.InstancedMesh(canopyGeometry, materials.treeLeaf, placements.length)
  const darkLeaves = new THREE.InstancedMesh(canopyGeometry, materials.treeLeafDark, Math.ceil(placements.length / 2))
  let darkIndex = 0

  trunks.castShadow = true
  leaves.castShadow = true
  darkLeaves.castShadow = true

  placements.forEach((placement, index) => {
    dummy.position.copy(placement.position)
    dummy.position.y += 1.2 * placement.scale
    dummy.rotation.set(0, placement.rotationY, 0)
    dummy.scale.set(placement.scale * 0.72, placement.scale, placement.scale * 0.72)
    dummy.updateMatrix()
    trunks.setMatrixAt(index, dummy.matrix)

    dummy.position.copy(placement.position)
    dummy.position.y += 2.95 * placement.scale
    dummy.rotation.set(0.08 * Math.sin(index), placement.rotationY, 0.05 * Math.cos(index))
    dummy.scale.set(placement.scale * 1.25, placement.scale * 0.95, placement.scale * 1.25)
    dummy.updateMatrix()
    leaves.setMatrixAt(index, dummy.matrix)

    if (index % 2 === 0) {
      dummy.position.copy(placement.position)
      dummy.position.x += 0.58 * placement.scale
      dummy.position.y += 3.24 * placement.scale
      dummy.position.z -= 0.44 * placement.scale
      dummy.rotation.set(0.14, placement.rotationY + 0.9, -0.08)
      dummy.scale.set(placement.scale * 0.86, placement.scale * 0.68, placement.scale * 0.86)
      dummy.updateMatrix()
      darkLeaves.setMatrixAt(darkIndex, dummy.matrix)
      darkIndex += 1
    }
  })

  trunks.instanceMatrix.needsUpdate = true
  leaves.instanceMatrix.needsUpdate = true
  darkLeaves.count = darkIndex
  darkLeaves.instanceMatrix.needsUpdate = true
  treeGroup.add(trunks, leaves, darkLeaves)
}

function buildTreeLine() {
  treeGroup.name = 'perimeter-tree-system'
  generatedTreeGroup.name = 'generated-tree-line'
  treePlacements.length = 0
  treeGroup.clear()
  generatedTreeGroup.clear()

  for (const side of [-1, 1]) {
    for (let index = 0; index < 30; index += 1) {
      const x = -FIELD_LENGTH / 2 - 12 + index * ((FIELD_LENGTH + 24) / 29) + (random() - 0.5) * 2.4
      const z = side * (FIELD_WIDTH / 2 + 16 + random() * 7)
      const scale = 1.05 + random() * 0.58
      treePlacements.push(makePlacement(x, 0, z, random() * Math.PI * 2, scale, index))
    }
  }

  for (const end of [-1, 1]) {
    for (let index = 0; index < 18; index += 1) {
      const x = end * (FIELD_LENGTH / 2 + 16 + random() * 8)
      const z = -FIELD_WIDTH / 2 - 8 + index * ((FIELD_WIDTH + 16) / 17) + (random() - 0.5) * 2
      const scale = 0.95 + random() * 0.55
      treePlacements.push(makePlacement(x, 0, z, random() * Math.PI * 2, scale, index))
    }
  }

  buildInstancedTrees(treePlacements)
  treeGroup.add(generatedTreeGroup)
  scene.add(treeGroup)
}

function enableShadows(object: THREE.Object3D, cast = true, receive = false) {
  object.traverse((child: THREE.Object3D) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = cast
      child.receiveShadow = receive
    }
  })
}

function createPlane(width: number, depth: number, material: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.receiveShadow = true
  return mesh
}

function addFieldLine(x: number, z: number, width: number, depth: number) {
  const line = new THREE.Mesh(new THREE.BoxGeometry(width, 0.045, depth), materials.line)
  line.position.set(x, 0.042, z)
  line.receiveShadow = true
  fieldGroup.add(line)
  return line
}

function createCircleLine(radius: number) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.055, 8, 96), materials.line)
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.08
  fieldGroup.add(ring)
}

function addRectLines(centerX: number, centerZ: number, width: number, depth: number, openSide: 'left' | 'right') {
  const halfW = width / 2
  const halfD = depth / 2
  addFieldLine(centerX, centerZ - halfD, width, 0.16)
  addFieldLine(centerX, centerZ + halfD, width, 0.16)
  const verticalX = openSide === 'left' ? centerX + halfW : centerX - halfW
  addFieldLine(verticalX, centerZ, 0.16, depth)
}

function buildField() {
  fieldGroup.name = 'field-system'
  scene.add(fieldGroup)

  const base = createPlane(FIELD_LENGTH + 6, FIELD_WIDTH + 6, materials.fieldDark)
  base.position.y = -0.012
  fieldGroup.add(base)

  const grass = createPlane(FIELD_LENGTH, FIELD_WIDTH, materials.field)
  grass.position.y = 0
  fieldGroup.add(grass)

  const stripeCount = 12
  const stripeWidth = FIELD_LENGTH / stripeCount
  for (let index = 0; index < stripeCount; index += 1) {
    if (index % 2 === 0) {
      const stripe = createPlane(stripeWidth, FIELD_WIDTH, materials.fieldStripe)
      stripe.position.set(-FIELD_LENGTH / 2 + stripeWidth * index + stripeWidth / 2, 0.006, 0)
      fieldGroup.add(stripe)
    }
  }

  addFieldLine(0, -FIELD_WIDTH / 2, FIELD_LENGTH, 0.18)
  addFieldLine(0, FIELD_WIDTH / 2, FIELD_LENGTH, 0.18)
  addFieldLine(-FIELD_LENGTH / 2, 0, 0.18, FIELD_WIDTH)
  addFieldLine(FIELD_LENGTH / 2, 0, 0.18, FIELD_WIDTH)
  addFieldLine(0, 0, 0.16, FIELD_WIDTH)
  createCircleLine(7.2)

  const centerSpot = new THREE.Mesh(new THREE.CircleGeometry(0.34, 24), materials.line)
  centerSpot.rotation.x = -Math.PI / 2
  centerSpot.position.y = 0.09
  fieldGroup.add(centerSpot)

  addRectLines(-FIELD_LENGTH / 2 + 8, 0, 16, 27, 'left')
  addRectLines(FIELD_LENGTH / 2 - 8, 0, 16, 27, 'right')
  addRectLines(-FIELD_LENGTH / 2 + 3.8, 0, 7.6, 15.5, 'left')
  addRectLines(FIELD_LENGTH / 2 - 3.8, 0, 7.6, 15.5, 'right')

  buildGoal('blue')
  buildGoal('red')
  buildStands()
  buildAudience()
  buildTreeLine()
}

function makeGoalNet(sign: number) {
  const points: THREE.Vector3[] = []
  const frontX = sign * (FIELD_LENGTH / 2 + 0.1)
  const backX = sign * (FIELD_LENGTH / 2 + GOAL_DEPTH)
  const zMin = -GOAL_WIDTH / 2
  const zMax = GOAL_WIDTH / 2

  for (let z = zMin; z <= zMax + 0.01; z += GOAL_WIDTH / 6) {
    points.push(new THREE.Vector3(frontX, GOAL_HEIGHT, z), new THREE.Vector3(backX, 0.35, z))
  }

  for (let y = 0.6; y <= GOAL_HEIGHT + 0.01; y += 0.75) {
    points.push(new THREE.Vector3(backX, y, zMin), new THREE.Vector3(backX, y, zMax))
  }

  for (let z = zMin; z <= zMax + 0.01; z += GOAL_WIDTH / 6) {
    points.push(new THREE.Vector3(backX, 0.35, z), new THREE.Vector3(backX, GOAL_HEIGHT, z))
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  return new THREE.LineSegments(geometry, materials.net)
}

function buildGoal(defendingTeam: Team) {
  const sign = defendingTeam === 'red' ? 1 : -1
  const group = new THREE.Group()
  const xFront = sign * (FIELD_LENGTH / 2 + 0.18)
  const xBack = sign * (FIELD_LENGTH / 2 + GOAL_DEPTH)
  const xMiddle = (xFront + xBack) / 2

  const postGeometry = new THREE.BoxGeometry(0.34, GOAL_HEIGHT, 0.34)
  const crossbarGeometry = new THREE.BoxGeometry(0.34, 0.34, GOAL_WIDTH + 0.34)
  const depthBarGeometry = new THREE.BoxGeometry(GOAL_DEPTH, 0.22, 0.22)

  for (const z of [-GOAL_WIDTH / 2, GOAL_WIDTH / 2]) {
    const frontPost = new THREE.Mesh(postGeometry, materials.goal)
    frontPost.position.set(xFront, GOAL_HEIGHT / 2, z)
    group.add(frontPost)

    const backPost = new THREE.Mesh(postGeometry, materials.goal)
    backPost.position.set(xBack, GOAL_HEIGHT / 2, z)
    group.add(backPost)
  }

  const crossbar = new THREE.Mesh(crossbarGeometry, materials.goal)
  crossbar.position.set(xFront, GOAL_HEIGHT, 0)
  group.add(crossbar)

  const backbar = new THREE.Mesh(crossbarGeometry, materials.goal)
  backbar.position.set(xBack, GOAL_HEIGHT, 0)
  group.add(backbar)

  for (const z of [-GOAL_WIDTH / 2, GOAL_WIDTH / 2]) {
    const topRail = new THREE.Mesh(depthBarGeometry, materials.goal)
    topRail.position.set(xMiddle, GOAL_HEIGHT, z)
    group.add(topRail)
  }

  const net = makeGoalNet(sign)
  group.add(net)
  enableShadows(group, true, false)
  fieldGroup.add(group)
}

function buildStands() {
  const standGroup = new THREE.Group()
  standGroup.name = 'procedural-stand-geometry'
  const seatMaterials = [materials.seatBlue, materials.seatRed, materials.seatLight]

  for (const side of [-1, 1]) {
    for (let row = 0; row < 5; row += 1) {
      const platform = new THREE.Mesh(new THREE.BoxGeometry(FIELD_LENGTH + 18, 0.7, 2.6), materials.stand)
      platform.position.set(0, 0.35 + row * 0.58, side * (FIELD_WIDTH / 2 + 5.4 + row * 2.18))
      platform.receiveShadow = true
      platform.castShadow = true
      standGroup.add(platform)
    }

    for (let index = 0; index < 54; index += 1) {
      const seat = new THREE.Mesh(
        new THREE.BoxGeometry(1.15, 0.55, 0.85),
        seatMaterials[(index + (side > 0 ? 1 : 0)) % seatMaterials.length],
      )
      seat.position.set(-FIELD_LENGTH / 2 - 8 + index * ((FIELD_LENGTH + 16) / 53), 1.4 + random() * 0.5, side * (FIELD_WIDTH / 2 + 9.6))
      seat.castShadow = true
      standGroup.add(seat)
    }
  }

  for (const end of [-1, 1]) {
    for (let row = 0; row < 4; row += 1) {
      const platform = new THREE.Mesh(new THREE.BoxGeometry(2.55, 0.64, FIELD_WIDTH - 7), materials.stand)
      platform.position.set(end * (FIELD_LENGTH / 2 + 6 + row * 2.1), 0.32 + row * 0.52, 0)
      platform.receiveShadow = true
      platform.castShadow = true
      standGroup.add(platform)
    }
  }

  scene.add(standGroup)
}

function buildLights() {
  const hemi = new THREE.HemisphereLight(0xddeeff, 0x31542c, 1.8)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xfff3d2, 3.1)
  sun.position.set(-35, 60, 26)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = -62
  sun.shadow.camera.right = 62
  sun.shadow.camera.top = 48
  sun.shadow.camera.bottom = -48
  sun.shadow.camera.near = 8
  sun.shadow.camera.far = 112
  sun.shadow.bias = -0.00008
  sun.shadow.normalBias = 0.025
  scene.add(sun)
}

function makePlayer(team: Team, number: number, home: THREE.Vector3, controlled = false): Footballer {
  const group = new THREE.Group()
  group.position.copy(home)
  group.name = `${team}-${number}`

  const kit = team === 'blue' ? materials.blue : materials.red
  const trim = team === 'blue' ? materials.blueTrim : materials.redTrim
  const fallbackGroup = new THREE.Group()
  fallbackGroup.name = 'fallback-player-capsule'

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.52, 1.05, 6, 14), kit)
  body.position.y = 1.35
  fallbackGroup.add(body)

  const chestBand = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.2, 0.9), trim)
  chestBand.position.y = 1.6
  fallbackGroup.add(chestBand)

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), materials.skin)
  head.position.y = 2.22
  fallbackGroup.add(head)

  const legGeometry = new THREE.CylinderGeometry(0.14, 0.16, 0.9, 10)
  const leftLeg = new THREE.Mesh(legGeometry, materials.black)
  const rightLeg = new THREE.Mesh(legGeometry, materials.black)
  leftLeg.position.set(0, 0.46, -0.25)
  rightLeg.position.set(0, 0.46, 0.25)
  fallbackGroup.add(leftLeg, rightLeg)
  group.add(fallbackGroup)

  const selector = new THREE.Mesh(new THREE.TorusGeometry(1.08, 0.045, 8, 64), materials.selector)
  selector.rotation.x = Math.PI / 2
  selector.position.y = 0.055
  selector.visible = controlled
  group.add(selector)

  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.9, 24), materials.shadowOnly)
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = 0.025
  shadow.receiveShadow = true
  group.add(shadow)

  enableShadows(group, true, false)
  scene.add(group)

  return {
    team,
    number,
    controlled,
    group,
    body,
    leftLeg,
    rightLeg,
    selector,
    fallbackGroup,
    home,
    target: home.clone(),
    velocity: new THREE.Vector3(),
    kickCooldown: 0,
    legPhase: random() * Math.PI * 2,
  }
}

function buildTeams() {
  const blueHomes = [
    new THREE.Vector3(-24, 0, 0),
    new THREE.Vector3(-29, 0, -12),
    new THREE.Vector3(-29, 0, 12),
    new THREE.Vector3(-35, 0, -7),
    new THREE.Vector3(-35, 0, 7),
  ]

  const redHomes = blueHomes.map((home) => new THREE.Vector3(-home.x, 0, -home.z))

  blueHomes.forEach((home, index) => {
    const player = makePlayer('blue', index + 1, home, index === 0)
    players.push(player)
    bluePlayers.push(player)
  })

  redHomes.forEach((home, index) => {
    const player = makePlayer('red', index + 1, home)
    players.push(player)
    redPlayers.push(player)
  })
}

function buildBall() {
  const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 28, 18), materials.ball)
  ballMesh.castShadow = true
  ball.add(ballMesh)

  const seam = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(BALL_RADIUS * 1.012, 2)),
    new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.32 }),
  )
  ball.add(seam)

  for (let index = 0; index < 8; index += 1) {
    const marker = new THREE.Mesh(new THREE.CircleGeometry(0.12, 12), materials.ballInk)
    const angle = (index / 8) * Math.PI * 2
    marker.position.set(Math.cos(angle) * BALL_RADIUS * 0.96, 0, Math.sin(angle) * BALL_RADIUS * 0.96)
    marker.lookAt(marker.position.clone().multiplyScalar(2))
    ball.add(marker)
  }

  ball.position.set(0, BALL_RADIUS, 0)
  scene.add(ball)
}

function resetRound() {
  state.phase = 'kickoff'
  state.timeLeft = ROUND_SECONDS
  state.kickoffTimer = 1.4
  statusEl.textContent = `Round ${state.round}`
  statusEl.hidden = false

  for (const player of players) {
    player.group.position.copy(player.home)
    player.velocity.set(0, 0, 0)
    player.kickCooldown = 0
    player.group.lookAt(player.group.position.x + teamDirection[player.team], 0, player.group.position.z)
  }

  ball.position.set(0, BALL_RADIUS, 0)
  ballVelocity.set(0, 0, 0)
  pointerHasTarget = false
  updateHud()
}

function finishMatch() {
  state.phase = 'finished'
  const result =
    state.blueScore > state.redScore ? 'Blue Wins' : state.redScore > state.blueScore ? 'Red Wins' : 'Draw'
  statusEl.textContent = `${result} ${state.blueScore}:${state.redScore}`
  statusEl.hidden = false
  restartEl.hidden = false
}

function endRound(scoringTeam?: Team) {
  if (scoringTeam === 'blue') {
    state.blueScore += 1
  } else if (scoringTeam === 'red') {
    state.redScore += 1
  }

  if (scoringTeam) {
    playSound('goal', 0.72)
  }
  playSound('whistle', 0.52)

  if (state.round >= MAX_ROUNDS) {
    updateHud()
    finishMatch()
    return
  }

  state.round += 1
  resetRound()
}

function updateHud() {
  blueScoreEl.textContent = String(state.blueScore)
  redScoreEl.textContent = String(state.redScore)
  roundLabelEl.textContent = `Round ${state.round}/${MAX_ROUNDS}`
  clockEl.textContent = state.phase === 'finished' ? '0.0' : state.timeLeft.toFixed(1)
}

function restartMatch() {
  state.blueScore = 0
  state.redScore = 0
  state.round = 1
  restartEl.hidden = true
  resetRound()
}

function setPointerTarget(event: PointerEvent) {
  const rect = canvas.getBoundingClientRect()
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointerNdc.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
  raycaster.setFromCamera(pointerNdc, camera)

  if (raycaster.ray.intersectPlane(pointerPlane, pointerTarget)) {
    pointerTarget.x = clamp(pointerTarget.x, -FIELD_LENGTH / 2 + 1.2, FIELD_LENGTH / 2 - 1.2)
    pointerTarget.z = clamp(pointerTarget.z, -FIELD_WIDTH / 2 + 1.2, FIELD_WIDTH / 2 - 1.2)
    pointerTarget.y = 0
    pointerHasTarget = true
  }
}

function getControlledPlayer() {
  return bluePlayers[0]
}

function getInputDirection() {
  const direction = new THREE.Vector3()

  if (keys.has('KeyW') || keys.has('ArrowUp')) direction.x += 1
  if (keys.has('KeyS') || keys.has('ArrowDown')) direction.x -= 1
  if (keys.has('KeyA') || keys.has('ArrowLeft')) direction.z -= 1
  if (keys.has('KeyD') || keys.has('ArrowRight')) direction.z += 1

  if (pointerActive && pointerHasTarget) {
    const controlled = getControlledPlayer()
    direction.copy(pointerTarget).sub(controlled.group.position)
    direction.y = 0

    if (direction.lengthSq() < 1.3) {
      direction.set(0, 0, 0)
    }
  }

  if (direction.lengthSq() > 0) {
    direction.normalize()
  }

  return direction
}

function distance2D(a: THREE.Vector3, b: THREE.Vector3) {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.hypot(dx, dz)
}

function movePlayer(player: Footballer, desiredDirection: THREE.Vector3, speed: number, deltaTime: number) {
  const desiredVelocity = tempVector.copy(desiredDirection).multiplyScalar(speed)
  player.velocity.lerp(desiredVelocity, dampAlpha(12, deltaTime))
  player.group.position.addScaledVector(player.velocity, deltaTime)

  player.group.position.x = clamp(player.group.position.x, -FIELD_LENGTH / 2 + PLAYER_RADIUS, FIELD_LENGTH / 2 - PLAYER_RADIUS)
  player.group.position.z = clamp(player.group.position.z, -FIELD_WIDTH / 2 + PLAYER_RADIUS, FIELD_WIDTH / 2 - PLAYER_RADIUS)
  player.group.position.y = 0

  if (player.velocity.lengthSq() > 0.08) {
    const lookAt = tempVector.copy(player.group.position).add(player.velocity)
    player.group.lookAt(lookAt.x, 0, lookAt.z)
  }

  const stride = player.velocity.length() * deltaTime
  player.legPhase += stride * 4.2
  const swing = Math.sin(player.legPhase) * Math.min(0.6, player.velocity.length() * 0.08)
  player.leftLeg.rotation.x = swing
  player.rightLeg.rotation.x = -swing
  player.body.position.y = 1.35 + Math.abs(Math.sin(player.legPhase)) * Math.min(0.06, player.velocity.length() * 0.008)
  if (player.visualModel) {
    player.visualModel.position.y = Math.abs(Math.sin(player.legPhase)) * Math.min(0.08, player.velocity.length() * 0.01)
  }
}

function findClosest(candidates: Footballer[], point: THREE.Vector3) {
  let closest = candidates[0]
  let bestDistance = Number.POSITIVE_INFINITY

  for (const candidate of candidates) {
    const distance = distance2D(candidate.group.position, point)
    if (distance < bestDistance) {
      bestDistance = distance
      closest = candidate
    }
  }

  return closest
}

function updateAi(deltaTime: number) {
  const closestBlueSupport = findClosest(bluePlayers.slice(1), ball.position)
  const closestRed = findClosest(redPlayers, ball.position)

  for (const player of players) {
    if (player.controlled) continue

    const sign = teamDirection[player.team]
    const supportShift = clamp(ball.position.x * 0.22, -9, 9)
    const laneShift = clamp(ball.position.z * 0.16, -5, 5)
    const shouldChase =
      player === closestRed ||
      (player === closestBlueSupport && distance2D(getControlledPlayer().group.position, ball.position) > 8)

    if (shouldChase) {
      player.target.copy(ball.position)
    } else {
      player.target.set(
        clamp(player.home.x + supportShift * sign, -FIELD_LENGTH / 2 + 4, FIELD_LENGTH / 2 - 4),
        0,
        clamp(player.home.z + laneShift, -FIELD_WIDTH / 2 + 4, FIELD_WIDTH / 2 - 4),
      )
    }

    tempVector.copy(player.target).sub(player.group.position)
    tempVector.y = 0
    const distance = tempVector.length()

    if (distance > 0.1) {
      tempVector.normalize()
    } else {
      tempVector.set(0, 0, 0)
    }

    const aiSpeed = shouldChase ? 7.1 : 5.1
    movePlayer(player, tempVector, aiSpeed, deltaTime)

    if (distance2D(player.group.position, ball.position) < 1.85) {
      const goalX = sign * FIELD_LENGTH / 2
      tempVector.copy(ball.position).setX(goalX).setZ(ball.position.z * 0.28)
      tempVector.sub(ball.position)
      tempVector.y = 0
      if (tempVector.lengthSq() > 0) {
        tempVector.normalize()
      }
      tryKick(player, tempVector, player.team === 'red' ? 18 : 15)
    }
  }
}

function resolvePlayerSpacing() {
  for (let firstIndex = 0; firstIndex < players.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < players.length; secondIndex += 1) {
      const first = players[firstIndex]
      const second = players[secondIndex]
      const offset = tempVector.copy(second.group.position).sub(first.group.position)
      offset.y = 0
      const distance = offset.length()
      const minimumDistance = PLAYER_RADIUS * 1.85

      if (distance > 0.001 && distance < minimumDistance) {
        const push = (minimumDistance - distance) * 0.5
        offset.normalize().multiplyScalar(push)
        second.group.position.add(offset)
        first.group.position.sub(offset)
      }
    }
  }
}

function tryKick(player: Footballer, direction: THREE.Vector3, strength: number) {
  if (state.phase !== 'playing' || player.kickCooldown > 0) return
  if (distance2D(player.group.position, ball.position) > 2.25) return

  tempVector.copy(direction)
  tempVector.y = 0

  if (tempVector.lengthSq() < 0.001) {
    tempVector.set(teamDirection[player.team], 0, 0)
  } else {
    tempVector.normalize()
  }

  ballVelocity.addScaledVector(tempVector, strength)
  ballVelocity.clampLength(0, 28)
  ball.position.addScaledVector(tempVector, 0.28)
  player.kickCooldown = 0.32
  playSound('kick', player.controlled ? 0.82 : 0.48)
}

function updateControlledPlayer(deltaTime: number) {
  const controlled = getControlledPlayer()
  const direction = getInputDirection()
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight')
  movePlayer(controlled, direction, sprint ? 9.6 : 7.8, deltaTime)

  if (kickRequested) {
    const shotDirection = tempVector2.copy(direction)
    if (shotDirection.lengthSq() < 0.001 && pointerHasTarget) {
      shotDirection.copy(pointerTarget).sub(controlled.group.position)
    }

    if (shotDirection.lengthSq() < 0.001) {
      shotDirection.set(1, 0, 0)
    }

    tryKick(controlled, shotDirection, sprint ? 23 : 19)
    kickRequested = false
  }
}

function updatePlayerBallContacts() {
  for (const player of players) {
    const offset = tempVector.copy(ball.position).sub(player.group.position)
    offset.y = 0
    const distance = offset.length()
    const minimumDistance = PLAYER_RADIUS + BALL_RADIUS

    if (distance > 0.001 && distance < minimumDistance) {
      const push = minimumDistance - distance
      offset.normalize()
      ball.position.addScaledVector(offset, push)
      ballVelocity.addScaledVector(offset, player.controlled ? 2.2 : 1.6)
    }
  }
}

function updateBall(deltaTime: number) {
  ball.position.addScaledVector(ballVelocity, deltaTime)
  ballVelocity.multiplyScalar(Math.exp(-1.55 * deltaTime))

  if (ballVelocity.lengthSq() < 0.006) {
    ballVelocity.set(0, 0, 0)
  }

  ball.position.y = BALL_RADIUS
  ball.rotation.z -= (ballVelocity.x * deltaTime) / BALL_RADIUS
  ball.rotation.x += (ballVelocity.z * deltaTime) / BALL_RADIUS

  if (ball.position.z < -FIELD_WIDTH / 2 + BALL_RADIUS) {
    ball.position.z = -FIELD_WIDTH / 2 + BALL_RADIUS
    ballVelocity.z = Math.abs(ballVelocity.z) * 0.68
  } else if (ball.position.z > FIELD_WIDTH / 2 - BALL_RADIUS) {
    ball.position.z = FIELD_WIDTH / 2 - BALL_RADIUS
    ballVelocity.z = -Math.abs(ballVelocity.z) * 0.68
  }

  const inGoalMouth = Math.abs(ball.position.z) < GOAL_WIDTH / 2

  if (ball.position.x > FIELD_LENGTH / 2 + GOAL_DEPTH * 0.45 && inGoalMouth) {
    endRound('blue')
    return
  }

  if (ball.position.x < -FIELD_LENGTH / 2 - GOAL_DEPTH * 0.45 && inGoalMouth) {
    endRound('red')
    return
  }

  if (ball.position.x > FIELD_LENGTH / 2 - BALL_RADIUS && !inGoalMouth) {
    ball.position.x = FIELD_LENGTH / 2 - BALL_RADIUS
    ballVelocity.x = -Math.abs(ballVelocity.x) * 0.62
  } else if (ball.position.x < -FIELD_LENGTH / 2 + BALL_RADIUS && !inGoalMouth) {
    ball.position.x = -FIELD_LENGTH / 2 + BALL_RADIUS
    ballVelocity.x = Math.abs(ballVelocity.x) * 0.62
  }
}

function updateCamera(deltaTime: number) {
  const controlled = getControlledPlayer()
  desiredLookTarget.lerpVectors(controlled.group.position, ball.position, 0.32)
  desiredLookTarget.y = 1.1

  desiredCameraPosition.copy(desiredLookTarget)
  desiredCameraPosition.add(new THREE.Vector3(-15, 16, 18))

  camera.position.lerp(desiredCameraPosition, dampAlpha(4.8, deltaTime))
  cameraLookTarget.lerp(desiredLookTarget, dampAlpha(6.2, deltaTime))
  camera.lookAt(cameraLookTarget)
}

function updateRound(deltaTime: number) {
  if (state.phase === 'finished') return

  if (state.phase === 'kickoff') {
    state.kickoffTimer -= deltaTime
    if (state.kickoffTimer <= 0) {
      state.phase = 'playing'
      statusEl.hidden = true
      playSound('whistle', 0.48)
    }
    return
  }

  state.timeLeft = Math.max(0, state.timeLeft - deltaTime)
  if (state.timeLeft <= 0) {
    endRound()
  }
}

function setDebugView(enabled: boolean) {
  debugView = enabled
  fieldGroup.traverse((child: THREE.Object3D) => {
    if (child instanceof THREE.Mesh) {
      const materialsToPatch = Array.isArray(child.material) ? child.material : [child.material]
      for (const material of materialsToPatch) {
        const wireMaterial = material as THREE.Material & { wireframe?: boolean }
        if (typeof wireMaterial.wireframe === 'boolean') {
          wireMaterial.wireframe = enabled
        }
      }
    }
  })
  fieldBounds.getCenter(tempVector)
}

function update(deltaTime: number) {
  const safeDelta = Math.min(deltaTime, 0.05)

  for (const player of players) {
    player.kickCooldown = Math.max(0, player.kickCooldown - safeDelta)
  }

  updateRound(safeDelta)

  if (state.phase !== 'finished') {
    updateControlledPlayer(safeDelta)
    updateAi(safeDelta)
    resolvePlayerSpacing()
    updatePlayerBallContacts()
    updateBall(safeDelta)
  }

  updateCamera(safeDelta)
  updateHud()
}

function animate(timestamp?: number) {
  timer.update(timestamp)
  const deltaTime = timer.getDelta()
  update(deltaTime)
  renderer.render(scene, camera)
  requestAnimationFrame(animate)
}

function resize() {
  const width = window.innerWidth
  const height = window.innerHeight
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  renderer.setSize(width, height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
}

window.addEventListener('resize', resize)
window.addEventListener('keydown', (event) => {
  unlockAudio()
  keys.add(event.code)

  if (event.code === 'Space') {
    event.preventDefault()
    kickRequested = true
  }

  if (event.code === 'Backquote') {
    setDebugView(!debugView)
  }

  if (event.code === 'KeyR' && state.phase === 'finished') {
    restartMatch()
  }
})

window.addEventListener('keyup', (event) => {
  keys.delete(event.code)
})

canvas.addEventListener('pointerdown', (event) => {
  unlockAudio()
  pointerActive = true
  setPointerTarget(event)
  canvas.setPointerCapture(event.pointerId)

  if (event.detail > 1) {
    kickRequested = true
  }
})

canvas.addEventListener('pointermove', (event) => {
  if (pointerActive) {
    setPointerTarget(event)
  }
})

canvas.addEventListener('pointerup', (event) => {
  pointerActive = false
  canvas.releasePointerCapture(event.pointerId)
})

canvas.addEventListener('pointercancel', () => {
  pointerActive = false
})

restartEl.addEventListener('click', () => {
  unlockAudio()
  restartMatch()
})

buildLights()
buildField()
buildTeams()
buildBall()
loadGameAssets()
resetRound()
resize()
requestAnimationFrame(animate)
