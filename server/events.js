// Limited-time events.
//
// An event is a single object on db.meta.event with a `type` drawn from
// EVENT_TYPES. Each type carries a `bonus` block; the server applies the
// economy parts (coins / XP / gems / gacha) and ships the whole block to the
// client, which applies the gameplay parts (chaos access, gauge rate, boss HP).

export const EVENT_TYPES = [
  {
    id: 'chaos', icon: '🌪️', name: 'カオスタイム', nameEn: 'Chaos Time',
    desc: 'カオスモードが全員に開放！コイン1.5倍',
    descEn: 'Chaos Mode opens up for everyone — 1.5× coins',
    bonus: { chaos: true },
  },
  {
    id: 'coinfes', icon: '🪙', name: 'コイン祭り', nameEn: 'Coin Festival',
    desc: 'すべてのモードで獲得コイン2倍！',
    descEn: 'Double coins in every mode!',
    bonus: { coin: 2 },
  },
  {
    id: 'xpboost', icon: '⭐', name: '経験値ブースト', nameEn: 'XP Boost',
    desc: 'パスXP・アカウントXPが2倍',
    descEn: 'Double battle-pass and account XP',
    bonus: { xp: 2 },
  },
  {
    id: 'gemrush', icon: '💎', name: 'ジェムラッシュ', nameEn: 'Gem Rush',
    desc: '1プレイごとにジェムが3個ドロップ',
    descEn: 'Every game drops 3 gems',
    bonus: { gemDrop: 3 },
  },
  {
    id: 'bossraid', icon: '🐲', name: 'ボス襲来', nameEn: 'Boss Invasion',
    desc: 'ボス戦の報酬2倍＋ボスHP-20%',
    descEn: 'Double boss rewards and bosses have 20% less HP',
    bonus: { bossCoin: 2, bossHp: 0.8 },
  },
  {
    id: 'ultfes', icon: '⚡', name: '奥義祭', nameEn: 'Ultimate Festival',
    desc: 'アルティメットゲージが2倍速で溜まる',
    descEn: 'The ultimate gauge charges twice as fast',
    bonus: { ultRate: 2 },
  },
  {
    id: 'lucky', icon: '🍀', name: 'ラッキーデー', nameEn: 'Lucky Day',
    desc: 'ガチャが20%オフ＋レア確率アップ',
    descEn: '20% off gacha pulls and better rare odds',
    bonus: { gachaDiscount: 0.8, gachaLuck: true },
  },
  {
    id: 'doubletrouble', icon: '🔥', name: '倍々デー', nameEn: 'Double Trouble',
    desc: 'コインもXPも2倍！最大級のお祭り',
    descEn: 'Double coins AND double XP — the big one',
    bonus: { coin: 2, xp: 2 },
  },
];

export function eventType(id) {
  return EVENT_TYPES.find(e => e.id === id) || null;
}

// The bonus block of the live event, or an empty object.
export function eventBonus(ev) {
  return (ev && ev.bonus) || {};
}

// Build a stored event record from admin input.
export function makeEvent(typeId, name, minutes, username) {
  const type = eventType(typeId) || EVENT_TYPES[0];
  return {
    id: type.id,          // legacy field name kept for older clients
    type: type.id,
    icon: type.icon,
    name: name || type.name,
    // 管理者が独自名を付けたときはそれを両言語で使う（誤訳よりマシ）。
    nameEn: name && name !== type.name ? name : type.nameEn,
    desc: type.desc,
    descEn: type.descEn,
    bonus: type.bonus,
    startedAt: Date.now(),
    endsAt: Date.now() + minutes * 60 * 1000,
    startedBy: username || null,
  };
}
