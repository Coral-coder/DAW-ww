// Ready-to-play Strudel snippets for the code editor. Every example only uses features
// implemented by this engine (tests evaluate all of them).

export const CODE_EXAMPLES = [
  {
    id: 'house-groove',
    name: 'House Groove',
    genre: 'house',
    code: `// four-on-the-floor house
setcpm(124/4)

$: s("bd*4").gain(.95)
$: s("~ cp ~ cp").room(.2)
$: s("[~ hh]*4").gain(.6)
$: s("~ ~ ~ oh").gain(.5)
$: note("<[c2 ~ c3 ~]*2 [a1 ~ a2 ~]*2>")
  .s("sawtooth").lpf(sine.range(300, 1400).slow(8)).lpq(6).release(.1)
$: chord("<Cm7 Am7b5 Fm7 G7>").voicing().s("triangle").gain(.35).room(.4)`,
  },
  {
    id: 'techno-drive',
    name: 'Techno Drive',
    genre: 'techno',
    code: `// driving peak-time techno
setcpm(132/4)

$: s("bd*4").shape(.3)
$: s("[~ hh]*4, hh*16?").gain(".7 .4")
$: s("~ cp").every(4, x => x.ply(2)).room(.3)
$: note("c2 [~ c2] eb2 [c2 g1]").s("sawtooth")
  .lpf(sine.range(200, 2400).slow(4)).lpq(10).decay(.15).sustain(0)`,
  },
  {
    id: 'dnb-break',
    name: 'Drum & Bass Break',
    genre: 'drum-and-bass',
    code: `// two-step dnb at 174
setcpm(174/4)

$: s("bd ~ ~ ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ ~ ~")
$: s("~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~")
$: s("hh*8").gain(".8 .5").sometimes(x => x.ply(2))
$: note("<e1 e1 g1 [a1 b1]>").s("sawtooth").lpf(400).legato(.9)`,
  },
  {
    id: 'trap-hats',
    name: 'Trap Hats',
    genre: 'trap',
    code: `// trap: rolling hats with ratchets
setcpm(140/4)

$: s("bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~")
$: s("~ ~ sd ~").room(.25)
$: s("hh*8").ply("<1 [1 2] 1 [1 1 3 1]>").gain(".8 .5 .7 .5")
$: note("<c1 c1 eb1 g0>").s("sine").decay(1.2).sustain(.2).shape(.4)`,
  },
  {
    id: 'lofi-chords',
    name: 'Lo-fi Chords',
    genre: 'lofi',
    code: `// lazy lo-fi keys built from scale degrees
setcpm(78/4)

$: n("<[0,2,4,6] [3,5,7,9] [1,3,5,7] [4,6,8,10]>")
  .scale("D4:dorian").s("triangle").attack(.05).release(.6)
  .lpf(1800).gain(.4).room(.5)
$: n("<0 3 1 4>").scale("D2:dorian").s("sine").gain(.7)
$: s("bd ~ ~ bd ~ ~ sd ~").swingBy(1/3, 4)
$: s("hh*8").gain(.35).degradeBy(.2)`,
  },
  {
    id: 'acid-line',
    name: 'Acid Line',
    genre: 'acid',
    code: `// 303-style acid squelch
setcpm(128/4)

$: s("bd*4")
$: note("c2 c3 [~ c2] eb2 c2 [g2 c3] c2 bb1")
  .s("sawtooth").lpf(sine.range(300, 3000).slow(4)).lpq(18)
  .decay(.12).sustain(0).shape(.3).delay(.25).delaytime(.1875)`,
  },
  {
    id: 'ambient-drift',
    name: 'Ambient Drift',
    genre: 'ambient',
    code: `// slow evolving pads
setcpm(60/4)

$: n("<[0,4,7] [2,5,9] [-1,4,6] [1,4,8]>").scale("E3:major")
  .s("triangle").attack(1.5).release(3).gain(.35).room(.9).size(.9).slow(2)
$: n("0 4 7 9 11 7".add("<0 2>")).scale("E4:major:pentatonic").s("sine")
  .degradeBy(.4).gain(.25).delay(.5).delaytime(.375).delayfeedback(.6).slow(2)`,
  },
  {
    id: 'jungle-amen',
    name: 'Jungle Chop',
    genre: 'jungle',
    code: `// chopped jungle-style break
setcpm(165/4)

$: s("bd ~ [~ bd] ~, ~ sd ~ [sd ~ ~ sd]").iter(4)
$: s("hh*8").gain(".6 .4").sometimesBy(.3, x => x.speed(1.5))
$: note("<a1 [~ a1] f1 [g1 e1]>").s("sine").shape(.5).lpf(300)`,
  },
  {
    id: 'reggaeton',
    name: 'Reggaeton Dembow',
    genre: 'reggaeton',
    code: `// dembow riddim
setcpm(96/4)

$: s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~")
$: s("~ ~ ~ sd ~ ~ sd ~ ~ ~ ~ sd ~ ~ sd ~")
$: s("hh*8").gain(.5)
$: note("<[a2,c3,e3] [f2,a2,c3] [c3,e3,g3] [g2,b2,d3]>").s("square").gain(.25).lpf(1500)`,
  },
  {
    id: 'polyrhythm-demo',
    name: 'Polyrhythm & Polymeter',
    genre: 'experimental',
    code: `// 3 against 4 and a {5 step} polymeter
setcpm(100/4)

$: s("[bd bd bd, hh hh hh hh]")
$: note("{c3 eb3 g3 bb3 d4}%8").s("square").gain(.3).lpf(1200)
$: s("{rim cb rim}%4").gain(.5)`,
  },
  {
    id: 'euclid-demo',
    name: 'Euclidean Rhythms',
    genre: 'experimental',
    code: `// euclidean patterns: (pulses, steps, rotation)
setcpm(120/4)

$: s("bd(3,8)")
$: s("sd(<2 3>,8,2)")
$: s("hh(5,8)").gain(.6)
$: s("rim(7,16,3)").gain(.4)
$: note("c2(3,8)").s("sawtooth").lpf(600)`,
  },
  {
    id: 'chiptune-arps',
    name: 'Chiptune Arps',
    genre: 'chiptune',
    code: `// 8-bit arpeggios
setcpm(150/4)

$: n("<[0,2,4] [5,7,9] [3,5,7] [4,6,8]>").scale("A3:minor")
  .arp("0 1 2 1 0 2 1 2").s("square").gain(.3).decay(.1).sustain(.3)
$: n("<0 5 3 4>").scale("A1:minor").s("triangle").gain(.6)
$: s("bd sd bd [sd sd]").crush(4)`,
  },
  {
    id: 'jazz-walk',
    name: 'Jazz Walking Bass',
    genre: 'jazz',
    code: `// ii-V-I with walking bass and swung ride
setcpm(120/4)

$: chord("<Dm7 G7 C^7 C^7>").voicing().s("triangle").gain(.3).struct("~ x ~ x")
$: note("<[d2 f2 a2 c3] [g2 b2 d3 f3] [c2 e2 g2 b2] [c3 a2 g2 e2]>").s("sine").gain(.8)
$: s("rd rd*2 rd rd*2").gain(.4).swing(4)`,
  },
  {
    id: 'breakbeat-variations',
    name: 'Breakbeat Variations',
    genre: 'breakbeat',
    code: `// classic transformations: every, chunk, off, rev
setcpm(130/4)

$: s("bd ~ sd [~ bd] ~ bd sd ~").every(4, x => x.rev()).chunk(4, x => x.hurry(2))
$: s("hh*8").off(1/16, x => x.gain(.3))
$: note("c3 eb3 g3 bb3").s("sawtooth").lpf(900).palindrome().jux(x => x.fast(2))`,
  },
  {
    id: 'dub-techno',
    name: 'Dub Techno Chords',
    genre: 'dub-techno',
    code: `// echoing minor chord stabs
setcpm(118/4)

$: s("bd*4")
$: s("[~ hh]*4").gain(.5)
$: chord("<Cm9 Cm9 Fm9 Gm7>").voicing().struct("~ x ~ ~ ~ ~ x ~").s("sawtooth")
  .lpf(sine.range(500, 1600).slow(16)).room(.6).delay(.6).delaytime(.375).delayfeedback(.7).gain(.35)`,
  },
  {
    id: 'trance-gate',
    name: 'Trance Gate',
    genre: 'trance',
    code: `// supersaw gated chords
setcpm(138/4)

$: s("bd*4, ~ oh ~ oh")
$: chord("<Am F C G>").voicing().s("supersaw")
  .struct("x x ~ x x ~ x x x ~ x x ~ x ~ x").gain(.3).lpf(2500).release(.05)
$: n("0 7 3 7 5 7 3 7").scale("A3:minor").s("square").gain(.2).lpf(perlin.range(800, 3000))`,
  },
  {
    id: 'afrobeat',
    name: 'Afro Percussion',
    genre: 'afrobeat',
    code: `// interlocking percussion with random choices
setcpm(110/4)

$: s("bd ~ ~ bd ~ ~ bd ~")
$: s("~ cp ~ cp")
$: s("[sh sh sh sh]*2").gain(".5 .3 .4 .3")
$: s("perc(5,12)").n(irand(4)).gain(.5)
$: s("[cb|rim|cl]*4").gain(.4)`,
  },
  {
    id: 'random-melody',
    name: 'Generative Melody',
    genre: 'generative',
    code: `// melody from a continuous random signal
setcpm(90/4)

$: n(irand(8).segment(8)).scale("C4:minor:pentatonic")
  .s("triangle").gain(.4).room(.5).sometimes(x => x.add(7))
$: n("<0 -3 -2 -4>").scale("C2:minor").s("sawtooth").lpf(500).gain(.6)
$: s("bd ~ [~ bd] ~, ~ hh ~ hh")`,
  },
  {
    id: 'stack-arrange',
    name: 'Arrangement',
    genre: 'pop',
    code: `// arrange sections lasting several cycles
setcpm(112/4)

const verse = stack(s("bd ~ sd ~"), note("c3 e3 g3 e3").s("square").gain(.3))
const chorus = stack(s("bd bd sd [~ bd]"), note("[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]").s("sawtooth").gain(.3))

arrange([4, verse], [4, chorus])`,
  },
];
