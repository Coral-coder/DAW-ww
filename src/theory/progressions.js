// Named progression library + functional-harmony analysis and next-chord suggestions.
import { mod12 } from './notes.js';
import { resolveScaleId, isMinorScale, heptatonicParent } from './scales.js';
import { CHORD_TYPES } from './chords.js';
import { romanToChord, diatonicChord, isDiatonic, chordToRoman } from './keys.js';

const P = (name, romans, mode, genres, moods, description, durs) => ({ name, romans, mode, genres, moods, description, ...(durs ? { durs } : {}) });

/**
 * PROGRESSIONS {id: {name, romans[], mode:'major'|'minor', genres[], moods[], description, durs?[] (bars per chord, default 1)}}
 * Accidentals are relative to the major scale of the tonic (so minor keys read i–bVI–bIII–bVII).
 */
export const PROGRESSIONS = {
  // ---------- Pop / rock staples ----------
  'pop-axis': P('Pop Axis (I–V–vi–IV)', ['I', 'V', 'vi', 'IV'], 'major', ['pop', 'rock', 'country', 'edm', 'kpop', 'punk', 'reggae', 'folk', 'progressive-house'], ['uplifting', 'anthemic'], 'The most used pop progression of the last 40 years.'),
  'axis-minor': P('Sensitive Axis (vi–IV–I–V)', ['vi', 'IV', 'I', 'V'], 'major', ['pop', 'edm', 'future-bass', 'trance', 'kpop', 'reggaeton', 'emo', 'progressive-house'], ['emotional', 'bittersweet'], 'Axis rotated to start on the relative minor — emotional EDM/pop.'),
  'axis-iv-start': P('Axis from IV (IV–I–V–vi)', ['IV', 'I', 'V', 'vi'], 'major', ['pop', 'rock', 'edm', 'country'], ['hopeful', 'lifting'], 'Starts away from home, so the I arrives as a release.'),
  'fifties': P("50s / Doo-wop (I–vi–IV–V)", ['I', 'vi', 'IV', 'V'], 'major', ['pop', 'doo-wop', 'rock', 'gospel', 'chiptune'], ['nostalgic', 'sweet'], 'The "Stand By Me" / doo-wop changes.'),
  'three-chord': P('Three-chord trick (I–IV–V–I)', ['I', 'IV', 'V', 'I'], 'major', ['rock', 'punk', 'country', 'folk', 'blues', 'reggae'], ['simple', 'driving'], 'Rock and roll, punk and folk bedrock.'),
  'i-iv-vi-v': P('I–IV–vi–V', ['I', 'IV', 'vi', 'V'], 'major', ['pop', 'country', 'folk', 'afrobeat'], ['warm', 'uplifting'], 'A softer axis variant.'),
  'i-iii-iv-v': P('I–iii–IV–V', ['I', 'iii', 'IV', 'V'], 'major', ['pop', 'rock', 'indie'], ['climbing', 'hopeful'], 'Stepwise climb that builds to the V.'),
  'canon': P('Pachelbel Canon', ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'], 'major', ['pop', 'cinematic', 'classical', 'kpop', 'folk'], ['romantic', 'timeless'], 'Descending-bass canon used in countless ballads.', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
  'creep': P('Creep (I–III–IV–iv)', ['I', 'III', 'IV', 'iv'], 'major', ['indie', 'rock', 'pop'], ['melancholic', 'bittersweet'], 'Chromatic mediant III and borrowed iv — Radiohead.'),
  'mixolydian-rock': P('Mixolydian rock (I–bVII–IV–I)', ['I', 'bVII', 'IV', 'I'], 'major', ['rock', 'indie', 'punk', 'country'], ['anthemic', 'swagger'], 'The bVII–IV double plagal of classic rock.'),
  'sweet-home': P('Double plagal (I–bVII–IV)', ['I', 'bVII', 'IV', 'IV'], 'major', ['rock', 'country', 'folk'], ['laid-back', 'southern'], '"Sweet Home Alabama"-style double plagal motion.'),
  'mario-cadence': P('Mario cadence (I–bVI–bVII–I)', ['I', 'bVI', 'bVII', 'I'], 'major', ['chiptune', 'cinematic', 'rock', 'eurobeat', 'synthwave'], ['heroic', 'triumphant'], 'Aeolian cadence borrowed from minor — triumphant video-game finish.'),
  'pop-punk': P('Pop-punk (I–V–vi–IV fast)', ['I', 'V', 'vi', 'IV'], 'major', ['punk', 'emo', 'rock'], ['energetic'], 'Axis played as fast 8th-note power chords.'),
  'secondary-lift': P('Secondary lift (I–III7–vi–IV)', ['I', 'III7', 'vi', 'IV'], 'major', ['pop', 'rock', 'gospel', 'cinematic'], ['dramatic', 'yearning'], 'III7 is V/vi — a secondary dominant that pulls hard into vi.'),
  'amen': P('Plagal amen (IV–I)', ['IV', 'I', 'IV', 'I'], 'major', ['gospel', 'folk', 'ambient', 'rock'], ['peaceful', 'spiritual'], 'Plagal motion — church "amen" cadence.'),
  'minor-plagal': P('Minor plagal (I–IV–iv–I)', ['I', 'IV', 'iv', 'I'], 'major', ['pop', 'rock', 'cinematic', 'soul'], ['bittersweet', 'nostalgic'], 'Borrowed iv adds a tear-jerking twist before home.'),
  'circle-diatonic': P('Diatonic circle of fifths', ['I', 'IV', 'vii°', 'iii', 'vi', 'ii', 'V', 'I'], 'major', ['jazz', 'baroque', 'pop', 'disco'], ['flowing', 'classic'], 'Every root falls a fifth — maximum forward motion.', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
  'vi-ii-v-i': P('vi–ii–V–I', ['vi', 'ii', 'V', 'I'], 'major', ['jazz', 'pop', 'doo-wop', 'disco', 'gospel'], ['classic', 'resolving'], 'Circle-of-fifths turnaround.'),
  // ---------- Jazz / soul / gospel ----------
  'ii-v-i': P('ii–V–I', ['ii7', 'V7', 'Imaj7', 'Imaj7'], 'major', ['jazz', 'bossa-nova', 'neo-soul', 'lofi-hip-hop', 'rnb', 'house', 'deep-house', 'gospel'], ['sophisticated', 'resolved'], 'The backbone of jazz harmony.'),
  'jazz-turnaround': P('Jazz turnaround (I–vi–ii–V)', ['Imaj7', 'vi7', 'ii7', 'V7'], 'major', ['jazz', 'lofi-hip-hop', 'rnb', 'bossa-nova', 'disco'], ['smooth', 'classic'], 'I–vi–ii–V in sevenths.'),
  'rhythm-changes': P('Rhythm changes A (I–VI7–ii–V)', ['Imaj7', 'VI7', 'ii7', 'V7'], 'major', ['jazz', 'swing'], ['bouncy', 'bebop'], 'Gershwin\'s "I Got Rhythm"; VI7 is V/ii.', [0.5, 0.5, 0.5, 0.5]),
  'minor-ii-v-i': P('Minor ii–V–i', ['iiø7', 'V7b9', 'i7', 'i7'], 'minor', ['jazz', 'bossa-nova', 'neo-soul', 'trip-hop', 'lofi-hip-hop'], ['dark', 'sophisticated'], 'Half-diminished ii and altered V into minor tonic.'),
  'tritone-sub': P('Tritone substitution (ii–bII7–I)', ['ii7', 'bII7', 'Imaj7', 'Imaj7'], 'major', ['jazz', 'neo-soul', 'rnb', 'gospel', 'bossa-nova'], ['slick', 'chromatic'], 'bII7 replaces V7 — chromatic bass slide into I.'),
  'backdoor': P('Backdoor ii–V (iv7–bVII7–I)', ['iv7', 'bVII7', 'Imaj7', 'Imaj7'], 'major', ['jazz', 'neo-soul', 'gospel', 'rnb'], ['warm', 'surprising'], 'Resolves from bVII7 instead of V7 — the "backdoor" cadence.'),
  'jazz-blues': P('Jazz blues (12 bars)', ['I7', 'IV7', 'I7', 'v7', 'I7', 'IV7', '#iv°7', 'I7', 'VI7', 'ii7', 'V7', 'I7', 'VI7', 'ii7', 'V7'], 'major', ['jazz', 'blues', 'swing'], ['swinging'], 'Bebop blues with ii–V turnarounds.', [1, 1, 1, 0.5, 0.5, 1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5]),
  'ragtime': P('Ragtime (I–VI7–II7–V7)', ['I', 'VI7', 'II7', 'V7'], 'major', ['jazz', 'swing', 'country', 'folk'], ['playful', 'vintage'], 'Chain of secondary dominants around the circle.'),
  'bossa-ipanema': P('Bossa (Imaj7–II7–ii7–bII7)', ['Imaj7', 'II7', 'ii7', 'bII7'], 'major', ['bossa-nova', 'jazz', 'lounge'], ['breezy', 'romantic'], 'Ipanema-style: II7 (V/V) then tritone sub.', [2, 2, 1, 1]),
  'just-the-two': P('Just the Two of Us', ['IVmaj7', 'III7', 'vi7', 'v7', 'I7'], 'major', ['neo-soul', 'rnb', 'city-pop', 'lofi-hip-hop', 'kpop', 'funk'], ['smooth', 'romantic'], 'IVmaj7–III7–vi7 with v7–I7 (ii–V of IV).', [1, 1, 1, 0.5, 0.5]),
  'royal-road': P('Royal Road (IVmaj7–V7–iii7–vi)', ['IVmaj7', 'V7', 'iii7', 'vi7'], 'major', ['jpop', 'kpop', 'city-pop', 'future-bass', 'nu-disco', 'eurobeat', 'synthwave'], ['emotional', 'dramatic'], 'The J-pop "王道進行" — yearning anime energy.'),
  'neo-soul-descend': P('Neo-soul descent (IVmaj9–iii7–ii9–Imaj9)', ['IVmaj9', 'iii7', 'ii9', 'Imaj9'], 'major', ['neo-soul', 'rnb', 'lofi-hip-hop', 'jazz'], ['lush', 'mellow'], 'Stepwise falling extended chords.'),
  'neo-soul-251': P('Neo-soul ii–V–I with 9ths & 13ths', ['ii9', 'V13', 'Imaj9', 'vi9'], 'major', ['neo-soul', 'rnb', 'gospel', 'lofi-hip-hop', 'deep-house'], ['lush', 'warm'], 'Extended voicings on a classic turnaround.'),
  'gospel-walk': P('Gospel walk-up (I–I7–IV–#iv°7)', ['I', 'I7', 'IV', '#iv°7', 'I', 'VI7', 'ii7', 'V7'], 'major', ['gospel', 'soul', 'rnb', 'neo-soul'], ['uplifting', 'churchy'], 'I7 tonicizes IV, #iv°7 passing chord, VI7–ii–V turnaround.', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
  'gospel-1-4': P('Gospel 1–4 (Imaj9–IV/I–iii7–VI7)', ['Imaj9', 'IV', 'iii7', 'VI7', 'ii9', 'V13'], 'major', ['gospel', 'neo-soul', 'rnb'], ['joyful', 'churchy'], 'Gospel turnaround with secondary dominant VI7.', [1, 1, 0.5, 0.5, 0.5, 0.5]),
  'soul-vamp': P('Soul vamp (Imaj7–IVmaj7)', ['Imaj7', 'IVmaj7'], 'major', ['rnb', 'neo-soul', 'chillwave', 'ambient', 'house', 'nu-disco'], ['dreamy', 'relaxed'], 'Two-chord major-seventh vamp.'),
  'funk-vamp': P('Funk one-chord vamp (I9)', ['I9', 'I9'], 'major', ['funk', 'disco', 'afrobeat'], ['groovy'], 'One dominant 9 chord — the groove is the song.'),
  'dorian-vamp': P('Dorian vamp (i7–IV7)', ['i7', 'IV7'], 'minor', ['funk', 'house', 'deep-house', 'neo-soul', 'latin', 'afrobeat', 'nu-disco', 'acid-jazz'], ['groovy', 'hopeful'], 'Minor i with a major IV — the Dorian sound (Oye Como Va).'),
  // ---------- Blues ----------
  'twelve-bar-blues': P('12-bar blues', ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'], 'major', ['blues', 'rock', 'rockabilly', 'jazz', 'boogie', 'country'], ['gritty', 'classic'], 'The classic 12-bar form ending with a V turnaround.'),
  'quick-change-blues': P('12-bar blues (quick change)', ['I7', 'IV7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'], 'major', ['blues', 'rock', 'jazz'], ['gritty'], 'Quick change to IV in bar 2.'),
  'minor-blues': P('Minor blues (12 bars)', ['i7', 'i7', 'i7', 'i7', 'iv7', 'iv7', 'i7', 'i7', 'bVI7', 'V7', 'i7', 'V7'], 'minor', ['blues', 'jazz', 'rock', 'trip-hop'], ['dark', 'soulful'], 'Minor 12-bar with bVI7–V7 turnaround.'),
  'eight-bar-blues': P('8-bar blues', ['I7', 'V7', 'IV7', 'IV7', 'I7', 'V7', 'I7', 'V7'], 'major', ['blues', 'gospel', 'folk'], ['soulful'], 'Compact 8-bar blues.'),
  // ---------- Minor / dark ----------
  'aeolian-loop': P('Epic minor (i–bVI–bIII–bVII)', ['i', 'bVI', 'bIII', 'bVII'], 'minor', ['trance', 'edm', 'pop', 'synthwave', 'hardstyle', 'reggaeton', 'cinematic', 'dubstep', 'future-bass', 'progressive-house', 'eurobeat', 'liquid-dnb'], ['epic', 'emotional'], 'The axis in minor — the sound of epic EDM and film.'),
  'andalusian': P('Andalusian cadence (i–bVII–bVI–V)', ['i', 'bVII', 'bVI', 'V'], 'minor', ['flamenco', 'latin', 'rock', 'metal', 'cinematic', 'surf', 'pop'], ['dramatic', 'spanish'], 'Descending tetrachord ending on a major V.'),
  'minor-descend': P('Minor descent (i–bVII–bVI–bVII)', ['i', 'bVII', 'bVI', 'bVII'], 'minor', ['rock', 'metal', 'cinematic', 'trance', 'hardstyle', 'synthwave'], ['epic', 'determined'], 'Rocking between bVI and bVII, never quite resolving.'),
  'heroic-rise': P('Heroic rise (bVI–bVII–i)', ['bVI', 'bVII', 'i', 'i'], 'minor', ['cinematic', 'trance', 'metal', 'hardstyle', 'eurobeat'], ['heroic', 'triumphant'], 'Stepwise rise into the tonic — film-score triumph in minor.'),
  'minor-four': P('i–iv–v–i (natural minor)', ['i', 'iv', 'v', 'i'], 'minor', ['folk', 'dub', 'reggae', 'ambient', 'techno'], ['brooding', 'modal'], 'Pure Aeolian — no leading tone, soft and modal.'),
  'harmonic-minor-cadence': P('i–iv–V–i (harmonic minor)', ['i', 'iv', 'V', 'i'], 'minor', ['classical', 'cinematic', 'metal', 'latin', 'tango'], ['dramatic', 'classical'], 'Major V borrowed from harmonic minor for a strong pull home.'),
  'sad-trap': P('Trap minor loop (i–iv–bVI–V)', ['i', 'iv', 'bVI', 'V'], 'minor', ['trap', 'drill', 'rnb', 'phonk', 'hip-hop'], ['dark', 'sad'], 'Dark loop with a harmonic-minor V for tension.'),
  'trap-two-chord': P('Trap two-chord (i–bVI)', ['i', 'i', 'bVI', 'bVI'], 'minor', ['trap', 'drill', 'hip-hop', 'phonk', 'dubstep'], ['menacing', 'hypnotic'], 'Minimal two-chord loop leaving room for 808s and vocals.'),
  'trap-bells': P('Trap bells (i–bIII–bVII–iv)', ['i', 'bIII', 'bVII', 'iv'], 'minor', ['trap', 'hip-hop', 'rnb', 'phonk'], ['melancholic', 'atmospheric'], 'Common bell/piano loop in modern trap.'),
  'drill-phrygian': P('Drill phrygian (i–bII)', ['i', 'bII', 'i', 'bVII'], 'minor', ['drill', 'trap', 'phonk', 'psytrance', 'metal', 'industrial'], ['sinister', 'tense'], 'The flat-two half-step gives drill its menace.'),
  'drill-sliding': P('Drill (i–bVI–bVII–v)', ['i', 'bVI', 'bVII', 'v'], 'minor', ['drill', 'trap'], ['cold', 'dark'], 'Minor drill loop with natural minor v.'),
  'phonk-loop': P('Phonk (i–iv–i–v)', ['i', 'iv', 'i', 'v'], 'minor', ['phonk', 'hip-hop', 'trap'], ['gritty', 'memphis'], 'Memphis-style minor loop for cowbell melodies.'),
  'house-minor-7': P('House minor 7ths (i7–iv7)', ['i7', 'i7', 'iv7', 'iv7'], 'minor', ['house', 'deep-house', 'tech-house', 'garage', 'two-step', 'minimal', 'amapiano'], ['groovy', 'late-night'], 'Classic deep-house organ/stab movement in minor sevenths.'),
  'deep-house-9': P('Deep house (i9–bVImaj7–bVII–iv9)', ['i9', 'bVImaj7', 'bVII', 'iv9'], 'minor', ['deep-house', 'house', 'garage', 'liquid-dnb', 'nu-disco'], ['lush', 'emotive'], 'Extended minor chords for warm deep-house pads.'),
  'garage-stabs': P('UK garage stabs (i7–iv7–bVII7–bIIImaj7)', ['i7', 'iv7', 'bVII7', 'bIIImaj7'], 'minor', ['garage', 'two-step', 'house', 'rnb'], ['bouncy', 'soulful'], 'Organ-stab friendly minor-7 movement.'),
  'trance-uplift': P('Uplifting trance (i–bVI–bVII–i)', ['i', 'bVI', 'bVII', 'i'], 'minor', ['trance', 'psytrance', 'hardstyle', 'eurobeat', 'progressive-house'], ['euphoric', 'driving'], 'bVI–bVII climb back to i — euphoric breakdowns.'),
  'trance-anthem': P('Trance anthem (vi–IV–V–iii)', ['vi', 'IV', 'V', 'iii'], 'major', ['trance', 'eurobeat', 'kpop', 'jpop'], ['euphoric', 'nostalgic'], 'Bittersweet anthem with deceptive V–iii.'),
  'synthwave-drive': P('Synthwave drive (i–bVI–bIII–bVII)', ['i', 'bVI', 'bIII', 'bVII'], 'minor', ['synthwave', 'chillwave', 'eurobeat', 'italo-disco'], ['nostalgic', 'neon'], 'Retro 80s minor loop.'),
  'synthwave-mediant': P('Outrun (i–bIII–bVII–bVI)', ['i', 'bIII', 'bVII', 'bVI'], 'minor', ['synthwave', 'chillwave', 'cinematic'], ['nostalgic', 'driving'], 'Mediant-led 80s soundtrack loop.'),
  'dnb-liquid': P('Liquid DnB (i9–bVImaj7–bIIImaj7–bVII)', ['i9', 'bVImaj7', 'bIIImaj7', 'bVII'], 'minor', ['liquid-dnb', 'drum-and-bass', 'deep-house', 'future-bass'], ['soulful', 'flowing'], 'Lush sevenths over rolling breaks.'),
  'dubstep-dark': P('Dubstep (i–bII–i–bVI)', ['i', 'bII', 'i', 'bVI'], 'minor', ['dubstep', 'brostep', 'industrial', 'drill'], ['menacing'], 'Phrygian bII for the heaviest drops.'),
  'techno-drone': P('Techno one-chord (i)', ['i', 'i'], 'minor', ['techno', 'minimal', 'psytrance', 'industrial', 'ambient'], ['hypnotic'], 'Single chord — tension comes from sound design and filter movement.'),
  'techno-two': P('Techno shift (i–bVII)', ['i', 'i', 'bVII', 'bVII'], 'minor', ['techno', 'minimal', 'tech-house', 'dub', 'trance'], ['hypnotic', 'driving'], 'Whole-step rock between i and bVII.'),
  'minor-line-cliche': P('Minor line cliché (i–i(maj7)–i7–i6)', ['i', 'imaj7', 'i7', 'i6'], 'minor', ['jazz', 'cinematic', 'trip-hop', 'bossa-nova', 'pop'], ['mysterious', 'noir'], 'Chromatic inner voice descends under a minor chord (James Bond).'),
  'trip-hop-noir': P('Trip-hop noir (i–bVImaj7–iv7–V7b9)', ['i', 'bVImaj7', 'iv7', 'V7b9'], 'minor', ['trip-hop', 'downtempo', 'cinematic', 'lofi-hip-hop'], ['noir', 'moody'], 'Smoky minor progression with an altered dominant.'),
  'boom-bap-soul': P('Boom bap soul flip (i7–bVImaj7–iv7–v7)', ['i7', 'bVImaj7', 'iv7', 'v7'], 'minor', ['boom-bap', 'hip-hop', 'lofi-hip-hop', 'rnb'], ['soulful', 'nostalgic'], 'Sample-style jazzy minor loop.'),
  'lofi-minor': P('Lo-fi minor (ii7–V7–i9–i9)', ['iiø7', 'V7', 'i9', 'i9'], 'minor', ['lofi-hip-hop', 'jazz', 'neo-soul'], ['wistful'], 'Jazzy minor resolution, perfect for dusty keys.'),
  'phrygian-flamenco': P('Flamenco (iv–bIII–bII–I)', ['iv', 'bIII', 'bII', 'I'], 'phrygian-dominant', ['flamenco', 'latin', 'metal', 'cinematic'], ['passionate', 'spanish'], 'Phrygian cadence resolving to a major tonic (Am–G–F–E in E).'),
  'metal-power': P('Metal power (i5–bVI5–bVII5–i5)', ['i5', 'bVI5', 'bVII5', 'i5'], 'minor', ['metal', 'rock', 'industrial', 'punk'], ['aggressive', 'heavy'], 'Power-chord aeolian riffing.'),
  'metal-tritone': P('Metal chromatic (i5–bII5–i5–bV5)', ['i5', 'bII5', 'i5', 'bV5'], 'minor', ['metal', 'industrial'], ['evil', 'heavy'], 'Half-step and tritone moves — the devil\'s interval.'),
  'cinematic-epic': P('Cinematic epic (i–bVI–bIII–bVII)', ['i', 'bVI', 'bIII', 'bVII', 'i', 'bVI', 'iv', 'V'], 'minor', ['cinematic', 'orchestral', 'trailer'], ['epic', 'heroic'], 'Hans-Zimmer-style minor loop ending on a dominant.'),
  'chromatic-mediant': P('Chromatic mediants (I–bVI–I–bIII)', ['I', 'bVI', 'I', 'bIII'], 'major', ['cinematic', 'orchestral', 'synthwave'], ['awe', 'wonder'], 'Mediant shifts sharing one common tone — magical film sound.'),
  'lydian-float': P('Lydian float (I–II)', ['I', 'II', 'I', 'II'], 'lydian', ['cinematic', 'ambient', 'chillwave', 'idm', 'indie'], ['dreamy', 'wonder'], 'Major II from Lydian #4 — the "flying" sound.'),
  'dark-tension': P('Tension (i–bVI–ii°–V)', ['i', 'bVI', 'ii°', 'V'], 'minor', ['cinematic', 'trailer', 'metal'], ['suspense'], 'Predominant ii° + dominant V build suspense.'),
  // ---------- Electronic / urban / world ----------
  'future-bass': P('Future bass (IVmaj7–V–vi7–I)', ['IVmaj7', 'V', 'vi7', 'Imaj7'], 'major', ['future-bass', 'kpop', 'pop', 'chillwave'], ['bright', 'emotional'], 'Lush 7ths for supersaw chord stabs.'),
  'chillwave': P('Chillwave (Imaj7–iii7–IVmaj7–iv6)', ['Imaj7', 'iii7', 'IVmaj7', 'iv6'], 'major', ['chillwave', 'downtempo', 'lofi-hip-hop', 'ambient', 'city-pop'], ['hazy', 'nostalgic'], 'Major sevenths melting into a borrowed iv6.'),
  'ambient-drift': P('Ambient drift (Imaj9–IVmaj9)', ['Imaj9', 'IVmaj9', 'vi9', 'IVmaj9'], 'major', ['ambient', 'downtempo', 'chillwave', 'idm'], ['calm', 'spacious'], 'Slow, open extended chords.', [2, 2, 2, 2]),
  'idm-planing': P('IDM planing (Imaj7–bIIImaj7–bVImaj7–IVmaj7)', ['Imaj7', 'bIIImaj7', 'bVImaj7', 'IVmaj7'], 'major', ['idm', 'glitch', 'ambient', 'downtempo'], ['strange', 'colorful'], 'Parallel major-7 planing across non-diatonic roots.'),
  'nu-disco': P('Nu-disco (vi7–ii7–V7–Imaj7)', ['vi7', 'ii7', 'V7', 'Imaj7'], 'major', ['nu-disco', 'disco', 'funk', 'house'], ['groovy', 'feel-good'], 'Circle progression with sevenths — instant disco.'),
  'disco-minor': P('Disco minor (i7–iv7–bVII7–bIIImaj7)', ['i7', 'iv7', 'bVII7', 'bIIImaj7'], 'minor', ['disco', 'nu-disco', 'funk', 'house'], ['groovy', 'glamorous'], 'Minor-key disco circle of fifths.'),
  'reggae-skank': P('Reggae (I–IV–V–IV)', ['I', 'IV', 'V', 'IV'], 'major', ['reggae', 'ska', 'dancehall', 'latin', 'afrobeat'], ['positive', 'laid-back'], 'Rocksteady/reggae chord cycle for offbeat skanks.'),
  'reggae-minor': P('Roots minor (i–iv)', ['i', 'i', 'iv', 'iv'], 'minor', ['reggae', 'dub', 'dancehall'], ['meditative', 'roots'], 'Two-chord roots riddim.'),
  'dub-rock': P('Dub (i–bVII)', ['i', 'bVII', 'i', 'bVII'], 'minor', ['dub', 'reggae', 'trip-hop', 'dancehall'], ['heavy', 'hypnotic'], 'Two-chord dub rock for deep bass and echo.'),
  'reggaeton': P('Reggaeton (vi–IV–I–V)', ['vi', 'IV', 'I', 'V'], 'major', ['reggaeton', 'latin-pop', 'dancehall'], ['sensual', 'catchy'], 'The Despacito changes over dembow.'),
  'reggaeton-minor': P('Reggaeton minor (i–bVI–bIII–bVII)', ['i', 'bVI', 'bIII', 'bVII'], 'minor', ['reggaeton', 'dancehall', 'latin-pop'], ['dark', 'sensual'], 'Minor perreo loop.'),
  'dancehall': P('Dancehall (i–bVII–bVI–bVII)', ['i', 'bVII', 'bVI', 'bVII'], 'minor', ['dancehall', 'afrobeat', 'reggaeton'], ['bouncy'], 'Minor dancehall riddim chord loop.'),
  'afrobeats': P('Afrobeats (I–iii–vi–IV)', ['I', 'iii', 'vi', 'IV'], 'major', ['afrobeat', 'afrobeats', 'amapiano', 'dancehall'], ['sunny', 'romantic'], 'Warm afropop progression.'),
  'highlife': P('Highlife (I–IV–I–V)', ['I', 'IV', 'I', 'V'], 'major', ['afrobeat', 'highlife', 'folk'], ['joyful'], 'West-African highlife guitar cycle.'),
  'amapiano': P('Amapiano (ii9–V9–Imaj9–vi9)', ['ii9', 'V9', 'Imaj9', 'vi9'], 'major', ['amapiano', 'deep-house', 'afrobeat'], ['smooth', 'soulful'], 'Jazzy extended chords over log drums.'),
  'amapiano-minor': P('Amapiano minor (i9–iv9)', ['i9', 'i9', 'iv9', 'iv9'], 'minor', ['amapiano', 'deep-house'], ['hypnotic', 'late-night'], 'Minor 9 vamp for log-drum grooves.'),
  'salsa-montuno': P('Salsa montuno (I–IV–V–IV)', ['I', 'IV', 'V7', 'IV'], 'major', ['salsa', 'latin'], ['festive'], 'Montuno cycle, piano anticipations over clave.', [0.5, 0.5, 0.5, 0.5]),
  'salsa-minor': P('Salsa minor (i–iv–V7–i)', ['i', 'iv', 'V7', 'i'], 'minor', ['salsa', 'latin', 'tango', 'bossa-nova'], ['passionate'], 'Minor tumbao progression.'),
  'country-turnaround': P('Country (I–IV–I–V7)', ['I', 'IV', 'I', 'V7'], 'major', ['country', 'folk', 'bluegrass', 'rockabilly'], ['honest', 'twangy'], 'Root–five country changes.'),
  'folk-ballad': P('Folk ballad (I–V–vi–iii–IV)', ['I', 'V', 'vi', 'iii', 'IV', 'IV', 'V', 'V'], 'major', ['folk', 'country', 'indie', 'cinematic'], ['heartfelt'], 'Canon-like storytelling progression.'),
  'indie-dreamy': P('Indie dreamy (Imaj7–vi7–IVmaj7–V)', ['Imaj7', 'vi7', 'IVmaj7', 'V'], 'major', ['indie', 'chillwave', 'shoegaze', 'pop'], ['dreamy', 'wistful'], 'Soft major sevenths for jangly guitars.'),
  'kpop-drama': P('K-pop drama (vi–IV–V–iii–vi)', ['vi', 'IV', 'V', 'iii'], 'major', ['kpop', 'jpop', 'eurobeat', 'trance'], ['dramatic', 'catchy'], 'Deceptive iii keeps the chorus in motion.'),
  'eurobeat': P('Eurobeat (i–bVI–bVII–i)', ['i', 'bVI', 'bVII', 'i'], 'minor', ['eurobeat', 'hardstyle', 'trance', 'italo-disco'], ['hyper', 'heroic'], 'Fast Initial-D style minor drive.'),
  'hardstyle-euphoric': P('Euphoric hardstyle (bVI–bVII–i–v)', ['bVI', 'bVII', 'i', 'v'], 'minor', ['hardstyle', 'trance', 'eurobeat'], ['euphoric', 'massive'], 'Big euphoric lead progression.'),
  'footwork-soul': P('Footwork soul chop (i7–bVImaj7)', ['i7', 'i7', 'bVImaj7', 'bVImaj7'], 'minor', ['footwork', 'juke', 'jungle', 'breakbeat'], ['frantic', 'soulful'], 'Chopped soul-sample harmony.'),
  'jungle-rave': P('Jungle rave (i–bVII–bVI–bVII)', ['i', 'bVII', 'bVI', 'bVII'], 'minor', ['jungle', 'breakbeat', 'drum-and-bass', 'hardcore'], ['rave', 'nostalgic'], 'Rave-era minor loop under chopped breaks.'),
  'psy-phrygian': P('Psy phrygian (i–bII)', ['i', 'i', 'bII', 'i'], 'phrygian', ['psytrance', 'techno', 'industrial'], ['trippy', 'dark'], 'Phrygian half-step riffing for psychedelic tension.'),
  'chiptune-hero': P('Chiptune hero (I–V–vi–iii–IV–I–IV–V)', ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'], 'major', ['chiptune', 'jpop', 'eurobeat'], ['adventurous'], 'Overworld-style canon progression.', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
  'industrial-grind': P('Industrial grind (i–bII–bv)', ['i5', 'i5', 'bII5', 'bV5'], 'minor', ['industrial', 'metal', 'techno'], ['brutal', 'mechanical'], 'Chromatic, tritone-heavy power chords.'),
};

/** Look up a progression by id or name; or pass a roman array straight through. */
export function getProgression(idOrRomans) {
  if (Array.isArray(idOrRomans)) return { name: 'Custom', romans: idOrRomans, mode: 'any', genres: [], moods: [] };
  if (PROGRESSIONS[idOrRomans]) return { id: idOrRomans, ...PROGRESSIONS[idOrRomans] };
  const hit = Object.entries(PROGRESSIONS).find(([, p]) => p.name.toLowerCase() === String(idOrRomans).toLowerCase());
  return hit ? { id: hit[0], ...hit[1] } : null;
}

const GENRE_TAG_ALIASES = {
  'uk-garage': ['garage'], salsa: ['latin'], orchestral: ['cinematic'], afrobeat: ['afrobeats'],
  'boom-bap': ['hip-hop'], brostep: ['dubstep'], 'liquid-dnb': ['drum-and-bass'], jungle: ['drum-and-bass'],
  'nu-disco': ['disco'], glitch: ['idm'], kpop: ['pop'],
};

/** Progressions filtered by genre/mood/mode. */
export function findProgressions({ genre, mood, mode } = {}) {
  const tags = genre ? [genre, ...(GENRE_TAG_ALIASES[genre] || [])] : null;
  return Object.entries(PROGRESSIONS)
    .filter(([, p]) => (!tags || p.genres.some((g) => tags.includes(g))) && (!mood || p.moods.includes(mood))
      && (!mode || p.mode === mode || (mode === 'minor' && p.mode !== 'major' && p.mode !== 'lydian') || (mode === 'major' && (p.mode === 'major' || p.mode === 'lydian'))))
    .map(([id, p]) => ({ id, ...p }));
}

// ---------------------------------------------------------------------------
// Functional analysis
// ---------------------------------------------------------------------------

const DOMINANT_TYPES = new Set(['7', '9', '11', '13', '7b9', '7#9', '7#11', '7b5', 'aug7', '7sus4', '9sus4']);

/**
 * Harmonic function of a chord in a key: 'tonic' | 'subdominant' | 'dominant' | 'secondary-dominant' | 'chromatic'.
 */
export function chordFunction(chord, keyRoot = 0, scaleId = 'major') {
  if (typeof chord === 'string') chord = romanToChord(chord, keyRoot, scaleId);
  if (!chord) return 'chromatic';
  const iv = mod12(chord.root - keyRoot);
  const minorKey = isMinorScale(scaleId);
  const diatonic = isDiatonic(chord, keyRoot, minorKey ? 'harmonic-minor' : scaleId) || isDiatonic(chord, keyRoot, scaleId);
  if (DOMINANT_TYPES.has(chord.type) && iv !== 7 && iv !== 10 && !diatonic) return 'secondary-dominant';
  switch (iv) {
    case 0: return 'tonic';
    case 3: return minorKey ? 'tonic' : 'chromatic';
    case 4: return 'tonic';
    case 9: return minorKey ? 'subdominant' : 'tonic';
    case 8: return 'subdominant';
    case 2: return 'subdominant';
    case 5: return 'subdominant';
    case 1: return 'subdominant';
    case 7: return 'dominant';
    case 11: return 'dominant';
    case 10: return minorKey ? 'dominant' : 'subdominant';
    case 6: return 'subdominant';
    default: return 'chromatic';
  }
}

const BORROW_SOURCES = [
  ['minor', 'parallel minor'], ['major', 'parallel major'], ['dorian', 'Dorian'], ['mixolydian', 'Mixolydian'],
  ['harmonic-minor', 'harmonic minor'], ['melodic-minor', 'melodic minor'], ['phrygian', 'Phrygian'], ['lydian', 'Lydian'],
];

/** Which parallel mode a non-diatonic chord is borrowed from (or null). */
export function borrowedFrom(chord, keyRoot, scaleId) {
  const own = resolveScaleId(heptatonicParent(scaleId));
  for (const [mode, label] of BORROW_SOURCES) {
    if (mode === own) continue;
    if (isDiatonic(chord, keyRoot, mode)) return { mode, label };
  }
  return null;
}

/**
 * analyzeProgression(romans, keyRoot=0, scaleId='major', opts={loop:true})
 * -> {key, chords:[{roman, chord, name, function, diatonic, borrowed, secondary}], cadences:[{type, at, text}],
 *     borrowed:[...], secondaryDominants:[...], notes:[string]}
 */
export function analyzeProgression(romans, keyRoot = 0, scaleId = 'major', opts = {}) {
  const loop = opts.loop !== false;
  const chords = romans.map((r) => {
    const chord = typeof r === 'string' ? romanToChord(r, keyRoot, scaleId) : r;
    if (!chord) return { roman: r, chord: null, name: '?', function: 'chromatic', diatonic: false, borrowed: null, secondary: null };
    const roman = typeof r === 'string' ? r : chordToRoman(chord, keyRoot);
    const diatonic = isDiatonic(chord, keyRoot, scaleId);
    const func = chordFunction(chord, keyRoot, scaleId);
    let secondary = null;
    if ((!diatonic && DOMINANT_TYPES.has(chord.type)) || chord.secondary) {
      const target = mod12(chord.root + 5);
      const targetChord = [0, 1, 2, 3, 4, 5, 6].map((d) => diatonicChord(keyRoot, scaleId, d)).find((c) => c.root === target);
      if (targetChord && mod12(target - keyRoot) !== 0) secondary = { target: targetChord.roman, text: `${roman} acts as V/${targetChord.roman}` };
    }
    const borrowed = !diatonic && !secondary ? borrowedFrom(chord, keyRoot, scaleId) : null;
    return { roman, chord, name: chord.name, function: secondary ? 'secondary-dominant' : func, diatonic, borrowed, secondary };
  });
  const cadences = [];
  const notes = [];
  const n = chords.length;
  const pairs = [];
  for (let i = 0; i < n - 1; i++) pairs.push([i, i + 1]);
  if (loop && n > 1) pairs.push([n - 1, 0]);
  const ivOf = (c) => (c.chord ? mod12(c.chord.root - keyRoot) : null);
  for (const [a, b] of pairs) {
    const A = chords[a], B = chords[b];
    if (!A.chord || !B.chord) continue;
    const ia = ivOf(A), ib = ivOf(B);
    const wrap = b === 0 && a === n - 1 ? ' (loop back)' : '';
    if ((ia === 7 || ia === 11) && ib === 0) cadences.push({ type: 'authentic', at: a, text: `Authentic cadence ${A.roman} → ${B.roman}${wrap}: the strongest resolution home.` });
    else if (ia === 5 && ib === 0) cadences.push({ type: 'plagal', at: a, text: `Plagal cadence ${A.roman} → ${B.roman}${wrap}: the soft "amen" resolution.` });
    else if (ia === 7 && ib === 9 && !isMinorScale(scaleId)) cadences.push({ type: 'deceptive', at: a, text: `Deceptive cadence ${A.roman} → ${B.roman}${wrap}: the ear expects I, gets vi.` });
    else if (ia === 7 && ib === 8 && isMinorScale(scaleId)) cadences.push({ type: 'deceptive', at: a, text: `Deceptive cadence ${A.roman} → ${B.roman}${wrap}: V resolving to bVI.` });
    else if (ia === 10 && ib === 0) cadences.push({ type: 'backdoor', at: a, text: `${A.roman} → ${B.roman}${wrap}: subtonic ("backdoor"/Mixolydian) cadence — rock and soul favourite.` });
    else if (ia === 1 && ib === 0) cadences.push({ type: 'phrygian', at: a, text: `${A.roman} → ${B.roman}${wrap}: Phrygian half-step resolution — dark and exotic.` });
    if (A.secondary && mod12(B.chord.root - A.chord.root) === 5) cadences.push({ type: 'secondary', at: a, text: `${A.roman} tonicizes ${B.roman} (secondary dominant resolving down a fifth).` });
  }
  // ii–V–I detection
  for (let i = 0; i + 2 < n; i++) {
    const [x, y, z] = [ivOf(chords[i]), ivOf(chords[i + 1]), ivOf(chords[i + 2])];
    if (x === 2 && y === 7 && z === 0) cadences.push({ type: 'ii-V-I', at: i, text: `${chords[i].roman}–${chords[i + 1].roman}–${chords[i + 2].roman} is a ii–V–I, the core jazz cadence.` });
    if (x === 8 && y === 10 && z === 0) cadences.push({ type: 'aeolian', at: i, text: `${chords[i].roman}–${chords[i + 1].roman}–${chords[i + 2].roman}: the bVI–bVII–I "Mario"/aeolian cadence — triumphant.` });
  }
  const last = chords[n - 1];
  if (n && last.chord && (ivOf(last) === 7) && !loop) cadences.push({ type: 'half', at: n - 1, text: 'Ends on V: a half cadence that leaves the phrase open.' });
  // andalusian descent
  const ivs = chords.map(ivOf).join(',');
  if (ivs.includes('0,10,8,7')) notes.push('Contains the Andalusian descent (i–bVII–bVI–V): a descending tetrachord with Spanish flavour.');
  const borrowed = chords.filter((c) => c.borrowed).map((c) => ({ roman: c.roman, from: c.borrowed.label, text: borrowText(c.roman, c.borrowed.label, ivOf(c)) }));
  const secondaryDominants = chords.filter((c) => c.secondary).map((c) => ({ roman: c.roman, target: c.secondary.target, text: c.secondary.text }));
  for (const b of borrowed) notes.push(b.text);
  for (const s of secondaryDominants) notes.push(`${s.text} — a secondary dominant that points strongly at ${s.target}.`);
  const funcs = chords.map((c) => c.function);
  if (!funcs.includes('dominant') && !funcs.includes('secondary-dominant') && n >= 3) notes.push('No dominant function: the loop floats rather than resolves — great for modal, hypnotic or ambient music.');
  if (n && chords[0].function === 'tonic') notes.push('Starts on the tonic, so the key is established immediately.');
  else if (n) notes.push(`Starts away from the tonic (${chords[0].roman}), creating forward pull toward home.`);
  const distinct = new Set(romans.map(String)).size;
  if (distinct <= 2 && n >= 2) notes.push('Only one or two chords: interest must come from rhythm, bass movement and sound design.');
  for (const c of cadences) notes.push(c.text);
  return { key: { root: mod12(keyRoot), scale: resolveScaleId(scaleId) }, chords, cadences, borrowed, secondaryDominants, notes };
}

function borrowText(roman, label, iv) {
  const flavour = {
    8: 'adds drama and cinematic weight', 10: 'gives an anthemic, rock lift', 3: 'darkens the colour with a heroic edge',
    5: 'brings a bittersweet, nostalgic sadness', 1: 'adds dark Neapolitan tension', 2: 'brightens with a Lydian lift',
    7: 'creates a strong leading-tone pull home', 9: 'adds a Dorian brightness to the minor key', 0: 'switches the tonic colour',
  };
  return `${roman} is borrowed from the ${label} — it ${flavour[iv] || 'adds modal colour'}.`;
}

// ---------------------------------------------------------------------------
// Next-chord suggestions
// ---------------------------------------------------------------------------

/**
 * suggestNextChords(progressionRomans[], keyRoot, scaleId, genre?, opts={limit:8})
 * -> [{roman, chord, reason, score}] best first.
 */
export function suggestNextChords(romans = [], keyRoot = 0, scaleId = 'major', genre = null, opts = {}) {
  const limit = opts.limit ?? 8;
  const minorKey = isMinorScale(scaleId);
  const out = new Map();
  const add = (roman, score, reason) => {
    const chord = romanToChord(roman, keyRoot, scaleId);
    if (!chord) return;
    const k = `${chord.root}:${chord.type}`;
    const prev = out.get(k);
    if (!prev || prev.score < score) out.set(k, { roman, chord, reason, score });
    else if (prev && prev.score >= score) prev.score = Math.min(1, prev.score + 0.03);
  };
  const T = minorKey ? 'i' : 'I';
  const lastRoman = romans.length ? romans[romans.length - 1] : null;
  const last = lastRoman ? (typeof lastRoman === 'string' ? romanToChord(lastRoman, keyRoot, scaleId) : lastRoman) : null;

  if (!last) {
    add(T, 1, `Start on the tonic (${T}) to establish the key.`);
    add(minorKey ? 'bVI' : 'vi', 0.7, minorKey ? 'Opening on bVI gives an epic, unresolved start.' : 'Starting on vi (relative minor) gives an emotional, axis-style opening.');
    add(minorKey ? 'iv' : 'IV', 0.65, `Starting on the subdominant creates pull back toward ${T}.`);
    return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
  const lastIv = mod12(last.root - keyRoot);
  const lastFunc = chordFunction(last, keyRoot, scaleId);

  // 1. Secondary dominant resolution
  const lastDiatonic = isDiatonic(last, keyRoot, scaleId);
  if ((last.secondary || (!lastDiatonic && DOMINANT_TYPES.has(last.type))) && lastIv !== 7) {
    const target = mod12(last.root + 5);
    for (let d = 0; d < 7; d++) {
      const dc = diatonicChord(keyRoot, scaleId, d);
      if (dc.root === target) add(dc.roman, 0.97, `${roman(last, keyRoot)} is a secondary dominant (V/${dc.roman}) — resolve it down a fifth to ${dc.roman}.`);
    }
  }

  // 2. Functional harmony
  const dia = (d, sev) => diatonicChord(keyRoot, scaleId, d, { sevenths: sev }).roman;
  if (minorKey) {
    if (lastIv === 7 || lastIv === 11) {
      add('i', 0.96, `${roman(last, keyRoot)} → i is the strongest resolution in minor.`);
      add('bVI', 0.72, `${roman(last, keyRoot)} → bVI is a deceptive cadence — the ear expects i but gets drama instead.`);
    }
    if (lastIv === 0) {
      add('iv', 0.8, 'i → iv moves to the subdominant, the natural first step away from home.');
      add('bVI', 0.82, 'i → bVI is the classic epic minor move (film scores, trance, trap).');
      add('bVII', 0.76, 'i → bVII steps down to the subtonic — rock/EDM momentum.');
      add('V', 0.6, 'i → V (from harmonic minor) adds immediate tension that wants to return home.');
      add('bIII', 0.6, 'i → bIII lifts to the relative major for a brighter moment.');
      add('iiø7', 0.45, 'i → iiø7 starts a minor ii–V–i (jazz, soul).');
    }
    if (lastIv === 5) {
      add('V', 0.85, 'iv → V: subdominant to dominant builds maximum tension before i.');
      add('i', 0.7, 'iv → i is a minor plagal cadence — soft and sombre.');
      add('bVII', 0.72, 'iv → bVII → i rocks home without a leading tone (aeolian).');
      add('bVI', 0.55, 'iv → bVI keeps the predominant area, delaying resolution.');
    }
    if (lastIv === 8) {
      add('bVII', 0.88, 'bVI → bVII → i is the heroic aeolian climb (film, trance, metal).');
      add('bIII', 0.78, 'bVI → bIII follows the epic minor loop (i–bVI–bIII–bVII).');
      add('V', 0.7, 'bVI → V is a dramatic half-step bass fall into the dominant (Andalusian).');
      add('iv', 0.6, 'bVI → iv keeps the subdominant mood darker.');
      add('i', 0.55, 'bVI → i returns home through a gentle common-tone move.');
    }
    if (lastIv === 10) {
      add('i', 0.82, 'bVII → i: the subtonic resolves up a whole step — rock/EDM cadence.');
      add('bVI', 0.75, 'bVII → bVI continues the Andalusian descent.');
      add('bIII', 0.7, 'bVII → bIII moves down a fifth (relative major cadence).');
      add('iv', 0.55, 'bVII → iv gives a melancholy turn.');
    }
    if (lastIv === 3) {
      add('bVII', 0.82, 'bIII → bVII continues the epic minor loop back toward i.');
      add('bVI', 0.7, 'bIII → bVI moves down a fifth — strong root motion.');
      add('iv', 0.6, 'bIII → iv climbs into the subdominant.');
    }
    if (lastIv === 2) {
      add('V', 0.92, `${roman(last, keyRoot)} → V is the minor ii–V; resolve to i next.`);
      add('V7b9', 0.6, 'iiø → V7b9 adds jazzy altered tension.');
    }
    if (lastIv === 1) add('i', 0.86, 'bII → i resolves the Phrygian half step — dark and exotic (drill, metal, flamenco).');
    if (lastIv === 1) add('V', 0.75, 'bII (Neapolitan) → V is the classical way to approach the dominant.');
  } else {
    if (lastIv === 7 || lastIv === 11) {
      add('I', 0.96, `${roman(last, keyRoot)} → I is the strongest resolution (authentic cadence).`);
      add('vi', 0.74, `${roman(last, keyRoot)} → vi is a deceptive cadence — the ear expects I and gets an emotional twist.`);
      if (lastIv === 7) add('IV', 0.5, 'V → IV is a softer "retrogression" heard in rock and blues.');
    }
    if (lastIv === 0) {
      add('IV', 0.82, 'I → IV moves to the subdominant — opening up away from home.');
      add('V', 0.78, 'I → V sets up tension that wants to come straight back.');
      add('vi', 0.78, 'I → vi drops to the relative minor for emotion (50s / axis progressions).');
      add('ii', 0.55, 'I → ii starts a ii–V–I return trip.');
      add('iii', 0.42, 'I → iii shares two notes with I — a subtle, gentle shift.');
    }
    if (lastIv === 2) {
      add('V', 0.95, 'ii → V is the backbone of the ii–V–I — the most common jazz/pop move.');
      add(dia(4, true), 0.82, 'ii → V7: the dominant 7th makes the pull to I even stronger.');
      add('bII7', 0.55, 'ii → bII7 is a tritone substitution — chromatic slide into I.');
      add('IV', 0.4, 'ii → IV keeps the subdominant area going.');
    }
    if (lastIv === 5) {
      add('V', 0.85, 'IV → V builds tension toward home — classic pre-chorus move.');
      add('I', 0.75, 'IV → I is the plagal "amen" cadence — soft resolution.');
      add('vi', 0.6, 'IV → vi keeps it emotional without resolving.');
      add('ii', 0.45, 'IV → ii: down a third, staying in subdominant colour.');
    }
    if (lastIv === 9) {
      add('IV', 0.86, 'vi → IV is the axis-progression move (vi–IV–I–V) — emotional pop.');
      add('ii', 0.78, 'vi → ii moves down a fifth — strong circle-of-fifths motion.');
      add('V', 0.62, 'vi → V climbs back toward the dominant.');
      add('iii', 0.45, 'vi → iii descends like the Pachelbel canon.');
    }
    if (lastIv === 4) {
      add('vi', 0.82, 'iii → vi falls a fifth — natural forward motion.');
      add('IV', 0.78, 'iii → IV steps up into the subdominant (canon / royal road).');
      add('ii', 0.45, 'iii → ii descends stepwise toward the dominant.');
    }
    if (lastIv === 10) {
      add('I', 0.82, 'bVII → I is the Mixolydian / backdoor cadence — rock and soul favourite.');
      add('IV', 0.8, 'bVII → IV is a double plagal move (classic rock).');
    }
    if (lastIv === 8) {
      add('bVII', 0.86, 'bVI → bVII → I is the triumphant "Mario" (aeolian) cadence.');
      add('V', 0.6, 'bVI → V slides down a half step into the dominant.');
      add('I', 0.6, 'bVI → I is a chromatic-mediant return — cinematic awe.');
    }
    if (lastIv === 3) add('IV', 0.55, 'bIII → IV climbs chromatically into the subdominant.');
    if (lastIv === 1) add('I', 0.9, 'bII7 → I resolves the tritone substitute by half step.');
  }

  // 3. Root motion down a fifth (generic)
  const fifthDown = mod12(last.root + 5);
  for (let d = 0; d < 7; d++) {
    const dc = diatonicChord(keyRoot, scaleId, d);
    if (dc.root === fifthDown) add(dc.roman, 0.6, `Root moving down a fifth (${roman(last, keyRoot)} → ${dc.roman}) is the most natural harmonic motion.`);
  }

  // 4. Secondary dominants: point at the next likely target
  const targets = minorKey ? [['iv', 0.5], ['bVI', 0.42], ['bIII', 0.4]] : [['ii', 0.5], ['vi', 0.52], ['IV', 0.48], ['V', 0.5]];
  for (const [tRoman, sc] of targets) {
    const t = romanToChord(tRoman, keyRoot, scaleId);
    if (!t || t.root === last.root) continue;
    const secRoman = `V7/${tRoman}`;
    const sec = romanToChord(secRoman, keyRoot, scaleId);
    if (sec && sec.root !== last.root) add(chordToRoman(sec, keyRoot), sc * (lastFunc === 'tonic' ? 1 : 0.85), `${chordToRoman(sec, keyRoot)} is V/${tRoman} — a secondary dominant that pulls strongly to ${tRoman}.`);
  }

  // 5. Modal interchange (borrowed chords)
  if (!minorKey) {
    add('iv', 0.5 + (lastIv === 5 ? 0.2 : 0), 'iv borrowed from the parallel minor gives a bittersweet, nostalgic colour.');
    add('bVI', 0.48, 'bVI borrowed from the parallel minor adds drama.');
    add('bVII', 0.5, 'bVII borrowed from Mixolydian gives an anthemic, rock lift.');
    add('bIII', 0.35, 'bIII borrowed from the parallel minor adds a heroic, bluesy edge.');
  } else {
    add('IV', 0.45, 'IV borrowed from Dorian brightens the minor key (funk, house, neo-soul).');
    add('V', 0.5, 'Major V borrowed from harmonic minor creates a strong leading-tone pull to i.');
    add('bII', 0.38, 'bII (Neapolitan / Phrygian) adds dark, cinematic tension.');
    add('I', 0.22, 'Picardy third: a major I lands with a surprising, uplifting brightness.');
  }

  // 6. Genre idioms: transitions found in the library for this genre
  if (genre) {
    const pool = findProgressions({ genre });
    for (const p of pool) {
      if ((p.mode === 'major') === minorKey && p.mode !== 'any') continue;
      const rs = p.romans;
      for (let i = 0; i < rs.length; i++) {
        const a = romanToChord(rs[i], keyRoot, scaleId);
        const b = romanToChord(rs[(i + 1) % rs.length], keyRoot, scaleId);
        if (!a || !b || a.root !== last.root) continue;
        if (CHORD_TYPES[a.type].minorish !== CHORD_TYPES[last.type].minorish) continue;
        if (b.root === last.root && b.type === last.type) continue;
        add(rs[(i + 1) % rs.length], 0.8, `Common in ${genre}: ${rs[i]} → ${rs[(i + 1) % rs.length]} (from "${p.name}").`);
      }
    }
  }

  // 7. Tonic always valid — but don't suggest repeating the same chord first
  for (const v of out.values()) {
    if (v.chord.root === last.root && v.chord.type === last.type) v.score *= 0.3;
    // functional-cycle bonus: phrase lengths of 4 want to resolve home on the 4th chord
    if (romans.length % 4 === 3 && (lastIv === 7 || lastIv === 11 || lastIv === 10) && v.chord.root === mod12(keyRoot)) v.score = Math.min(1, v.score + 0.05);
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((v) => ({ ...v, score: Math.round(v.score * 100) / 100 }));
}

function roman(chord, keyRoot) {
  return chord.roman || chordToRoman(chord, keyRoot);
}

/** Expand a progression (id or romans) into chord objects with durations in bars. */
export function progressionChords(idOrRomans, keyRoot = 0, scaleId = 'major') {
  const p = getProgression(idOrRomans);
  if (!p) return [];
  return p.romans.map((r, i) => ({ roman: r, bars: p.durs?.[i] ?? 1, chord: romanToChord(r, keyRoot, scaleId) })).filter((x) => x.chord);
}
