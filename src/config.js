// Game data: weapons, demons, shop items and wave tuning.

export const CATEGORIES = {
  pistol: 'პისტოლეტები',
  smg: 'პისტოლეტ-ავტომატები',
  shotgun: 'საფანტიანი თოფები',
  rifle: 'ავტომატები',
  lmg: 'ტყვიამფრქვევები',
  sniper: 'სნაიპერული შაშხანები',
  special: 'სპეციალური',
};

// type: hitscan | flame | tesla | beam | rocket
// rpm = shots per minute, spread = radians, pierce = extra enemies a bullet passes through
export const WEAPONS = [
  // Pistols
  { id: 'm9', name: 'M9', cat: 'pistol', price: 0, dmg: 24, rpm: 330, auto: false, mag: 15, reload: 1.1, spread: 0.025, range: 26 },
  { id: 'glock', name: 'Glock-18', cat: 'pistol', price: 350, dmg: 16, rpm: 900, auto: true, mag: 22, reload: 1.2, spread: 0.06, range: 24 },
  { id: 'deagle', name: 'Desert Eagle', cat: 'pistol', price: 700, dmg: 75, rpm: 200, auto: false, mag: 7, reload: 1.5, spread: 0.02, range: 30, pierce: 1 },
  { id: 'magnum', name: 'Magnum .357', cat: 'pistol', price: 950, dmg: 100, rpm: 150, auto: false, mag: 6, reload: 2.1, spread: 0.015, range: 30, pierce: 1 },
  // SMGs
  { id: 'uzi', name: 'UZI', cat: 'smg', price: 800, dmg: 14, rpm: 950, auto: true, mag: 32, reload: 1.6, spread: 0.09, range: 22 },
  { id: 'mp5', name: 'MP5', cat: 'smg', price: 1000, dmg: 18, rpm: 800, auto: true, mag: 30, reload: 1.7, spread: 0.05, range: 26 },
  { id: 'mp7', name: 'MP7', cat: 'smg', price: 1300, dmg: 20, rpm: 900, auto: true, mag: 40, reload: 1.8, spread: 0.05, range: 26 },
  { id: 'p90', name: 'P90', cat: 'smg', price: 1550, dmg: 20, rpm: 900, auto: true, mag: 50, reload: 2.0, spread: 0.055, range: 26 },
  { id: 'vector', name: 'KRISS Vector', cat: 'smg', price: 1850, dmg: 21, rpm: 1200, auto: true, mag: 33, reload: 1.6, spread: 0.06, range: 24 },
  // Shotguns
  { id: 'pump', name: 'Remington 870', cat: 'shotgun', price: 1100, dmg: 17, pellets: 8, rpm: 70, auto: false, mag: 6, reload: 2.4, spread: 0.17, range: 14 },
  { id: 'dbarrel', name: 'ორლულიანი', cat: 'shotgun', price: 1300, dmg: 20, pellets: 10, rpm: 200, auto: false, mag: 2, reload: 1.8, spread: 0.24, range: 12 },
  { id: 'spas', name: 'SPAS-12', cat: 'shotgun', price: 2000, dmg: 19, pellets: 9, rpm: 150, auto: false, mag: 8, reload: 2.6, spread: 0.16, range: 15 },
  { id: 'aa12', name: 'AA-12', cat: 'shotgun', price: 3400, dmg: 16, pellets: 8, rpm: 300, auto: true, mag: 20, reload: 3.0, spread: 0.18, range: 14 },
  // Rifles
  { id: 'ak47', name: 'AK-47', cat: 'rifle', price: 2000, dmg: 34, rpm: 600, auto: true, mag: 30, reload: 2.2, spread: 0.045, range: 34, pierce: 1 },
  { id: 'm4', name: 'M4A1', cat: 'rifle', price: 2200, dmg: 30, rpm: 750, auto: true, mag: 30, reload: 2.0, spread: 0.035, range: 34 },
  { id: 'famas', name: 'FAMAS', cat: 'rifle', price: 2400, dmg: 28, rpm: 950, auto: true, mag: 25, reload: 2.1, spread: 0.04, range: 32 },
  { id: 'aug', name: 'Steyr AUG', cat: 'rifle', price: 2700, dmg: 33, rpm: 700, auto: true, mag: 42, reload: 2.3, spread: 0.03, range: 36, pierce: 1 },
  { id: 'scar', name: 'SCAR-H', cat: 'rifle', price: 3000, dmg: 48, rpm: 550, auto: true, mag: 20, reload: 2.3, spread: 0.03, range: 36, pierce: 1 },
  // LMGs
  { id: 'm249', name: 'M249 SAW', cat: 'lmg', price: 3800, dmg: 32, rpm: 800, auto: true, mag: 100, reload: 4.5, spread: 0.07, range: 34, pierce: 1, move: 0.88 },
  { id: 'pkm', name: 'PKM', cat: 'lmg', price: 4600, dmg: 42, rpm: 700, auto: true, mag: 100, reload: 5.0, spread: 0.07, range: 36, pierce: 2, move: 0.85 },
  // Snipers
  { id: 'svd', name: 'Dragunov SVD', cat: 'sniper', price: 3200, dmg: 130, rpm: 180, auto: false, mag: 10, reload: 2.6, spread: 0.006, range: 50, pierce: 3 },
  { id: 'm24', name: 'M24', cat: 'sniper', price: 3600, dmg: 240, rpm: 50, auto: false, mag: 5, reload: 3.0, spread: 0, range: 50, pierce: 5 },
  { id: 'barrett', name: 'Barrett .50', cat: 'sniper', price: 5500, dmg: 420, rpm: 90, auto: false, mag: 10, reload: 3.5, spread: 0.004, range: 60, pierce: 8, move: 0.9 },
  // Special
  { id: 'flamer', name: 'ცეცხლსასროლი', cat: 'special', type: 'flame', price: 4200, dmg: 9, rpm: 1200, auto: true, mag: 150, reload: 3.5, range: 6.5, cone: 0.32 },
  { id: 'm32', name: 'M32 ყუმბარმტყორცნი', cat: 'special', type: 'rocket', price: 4800, dmg: 190, splash: 3.4, projSpeed: 17, rpm: 130, auto: false, mag: 6, reload: 3.6, spread: 0.02, range: 40 },
  { id: 'rpg', name: 'RPG-7', cat: 'special', type: 'rocket', price: 5800, dmg: 480, splash: 4.6, projSpeed: 22, rpm: 40, auto: false, mag: 1, reload: 2.5, spread: 0.01, range: 50, move: 0.9 },
  { id: 'tesla', name: 'ტესლას ქვემეხი', cat: 'special', type: 'tesla', price: 6500, dmg: 60, chain: 4, rpm: 400, auto: true, mag: 40, reload: 2.8, range: 11, cone: 0.5 },
  { id: 'laser', name: 'ლაზერული შაშხანა', cat: 'special', type: 'beam', price: 7000, dmg: 55, rpm: 500, auto: true, mag: 60, reload: 2.8, spread: 0.01, range: 40, pierce: 99, color: 0x33ffff },
  { id: 'minigun', name: 'მინიგანი', cat: 'special', price: 8500, dmg: 30, rpm: 2000, auto: true, mag: 300, reload: 6.0, spread: 0.09, range: 32, pierce: 1, move: 0.7 },
  { id: 'railgun', name: 'რელსური ქვემეხი', cat: 'special', type: 'beam', price: 10000, dmg: 950, rpm: 45, auto: false, mag: 4, reload: 3.2, spread: 0, range: 60, pierce: 99, color: 0x6f8cff },
];
export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));

// Each demon class has several models; one is picked at random per spawn.
export const ENEMY_TYPES = {
  easy: {
    key: 'easy', label: 'Easy', hp: 70, speed: 2.3, dmg: 12, atkRate: 1.1, reach: 0.75, radius: 0.42, coins: 10,
    variants: [
      { model: 'huggy', height: 2.2, anim: 1.0 },
      { model: 'nurse', height: 1.75 },
    ],
  },
  fast: {
    key: 'fast', label: 'Fast', hp: 34, speed: 5.0, dmg: 7, atkRate: 0.6, reach: 0.6, radius: 0.34, coins: 15,
    variants: [
      { model: 'chromie', height: 1.25 },
      { model: 'huggy', height: 1.6, anim: 2.3, tint: [1.0, 0.25, 0.22] },
    ],
  },
  brute: {
    key: 'brute', label: 'Brute', hp: 520, speed: 1.3, dmg: 32, atkRate: 1.6, reach: 1.0, radius: 0.62, coins: 45,
    variants: [
      { model: 'butcher', height: 2.5 },
      { model: 'siren', height: 2.7, anim: 0.55 },
    ],
  },
};

export const PLAYER = { hp: 100, speed: 4.2, radius: 0.3, eye: 1.62, downedTime: 10, downedHp: 80 };
// The black dog fights up close with her blades.
export const COMPANION = { name: 'შავი ძაღლი', hp: 170, speed: 4.8, dmg: 34, atkRate: 0.75, reach: 0.95, seek: 9, leash: 11, reviveTime: 2.5 };

// Three shop points in different parts of the station.
export const SHOPS = [
  { id: 'arms', name: 'იარაღის საწყობი', color: 0xffb020, at: [-8.5, -1.0] },
  { id: 'armor', name: 'ბრონი და ბომბები', color: 0x3aa0ff, at: [3.1, -6.3] },
  { id: 'med', name: 'გამაცოცხლებლები და ბუსტერები', color: 0x3dff7a, at: [8.1, -0.9] },
];

export const ARMOR_ITEMS = [
  { id: 'armor_light', name: 'მსუბუქი ბრონი', desc: '50 ბრონის ქულა', price: 300, armor: 50 },
  { id: 'armor_heavy', name: 'მძიმე ბრონიჟილეტი', desc: '100 ბრონის ქულა', price: 650, armor: 100 },
  { id: 'armor_jugg', name: 'ჯაგერნაუტის ბრონი', desc: '200 ბრონის ქულა', price: 1400, armor: 200 },
  { id: 'grenade', name: 'ყუმბარა ×3', desc: 'G ღილაკი — სროლა (მაქს. 10)', price: 250 },
  { id: 'mine', name: 'ნაღმი ×2', desc: 'F ღილაკი — დადება (მაქს. 8)', price: 300 },
];

export const MED_ITEMS = [
  { id: 'revive', name: 'გამაცოცხლებელი', desc: 'თუ დაცემულს მოგკლავენ — ფეხზე წამოგაყენებს (მაქს. 1)', price: 1500 },
  { id: 'medkit', name: 'სამედიცინო ნაკრები', desc: 'სრული სიცოცხლე', price: 200 },
  { id: 'boost_dmg', name: 'ორმაგი ზიანი', desc: '30 წამი ×2 ზიანი', price: 600, boost: 'dmg', time: 30 },
  { id: 'boost_rate', name: 'სწრაფი სროლა', desc: '30 წამი +65% სროლის სიჩქარე', price: 500, boost: 'rate', time: 30 },
  { id: 'boost_speed', name: 'სისწრაფე', desc: '30 წამი +40% სიარული', price: 300, boost: 'speed', time: 30 },
  { id: 'boost_regen', name: 'რეგენერაცია', desc: '45 წამი +6 სიცოცხლე/წმ', price: 400, boost: 'regen', time: 45 },
  { id: 'comp_heal', name: 'დამხმარის მკურნალობა', desc: 'შავი ძაღლის სრული სიცოცხლე', price: 150 },
  { id: 'comp_up', name: 'დამხმარის გაძლიერება', desc: '+ზიანი, +სიცოცხლე, +სისწრაფე (მაქს. 5 დონე)', price: 800 },
];

export const BOOST_LABELS = { dmg: '×2 ზიანი', rate: 'სწრაფი სროლა', speed: 'სისწრაფე', regen: 'რეგენი' };

export function waveComposition(wave) {
  const total = 8 + wave * 4;
  const fastShare = wave < 2 ? 0 : Math.min(0.35, 0.08 * wave);
  const bruteShare = wave < 3 ? 0 : Math.min(0.2, 0.03 * wave);
  const bossExtra = wave % 5 === 0 ? Math.floor(wave / 5) + 1 : 0; // every 5th wave brings extra brutes
  const list = [];
  const brutes = Math.round(total * bruteShare) + bossExtra;
  const fasts = Math.round(total * fastShare);
  for (let i = 0; i < brutes; i++) list.push('brute');
  for (let i = 0; i < fasts; i++) list.push('fast');
  while (list.length < total + bossExtra) list.push('easy');
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export function waveScaling(wave) {
  return {
    hp: 1 + (wave - 1) * 0.14,
    dmg: 1 + (wave - 1) * 0.06,
    speed: 1 + Math.min(0.3, wave * 0.015),
    maxAlive: Math.min(12 + wave * 2, 32),
    spawnGap: Math.max(0.35, 1.4 - wave * 0.07),
  };
}

export const BREAK_TIME = 20;
export const FIRST_BREAK = 12;
