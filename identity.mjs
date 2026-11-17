const FIRST_NAMES = [
  'Aarav', 'Vihaan', 'Aditya', 'Arjun', 'Kabir', 'Ishaan', 'Rohan', 'Krishna',
  'Ananya', 'Diya', 'Isha', 'Priya', 'Kavya', 'Meera', 'Saanvi', 'Anika', 'Riya', 'Aanya', 'Dev', 'Rehan',
];
const LAST_NAMES = [
  'Sharma', 'Patel', 'Singh', 'Verma', 'Reddy', 'Nair', 'Iyer', 'Khan', 'Gupta', 'Joshi', 'Mehta', 'Shah', 'Kapoor', 'Yadav', 'Das',
];
const SHORT_TITLES = [
  'Hero', 'Mitra', 'Sher', 'Sevak', 'Nagar', 'Gali', 'Diya', 'Rail', 'Senani', 'Rakshak', 'Sitara', 'Surya',
];
const LONG_TITLES = [
  'Gali Hero', 'Nagar Mitra', 'Desh Hero', 'Sadak Mitra', 'Pados Hero', 'Tiranga Mitra',
];
const AVATARS = [
  'tiranga', 'chakra', 'lotus', 'leaf', 'diya', 'peacock', 'tiger', 'cricket',
  'cycle', 'shield', 'train', 'star', 'moon', 'sun', 'boat', 'hero',
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function tag() {
  return Math.floor(10 + Math.random() * 90);
}

export function randomIndianName() {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

export function randomUsername(style = 'short') {
  if (style === 'long') return `${pick(LONG_TITLES)} ${tag()}`;
  return `${pick(SHORT_TITLES)}${tag()}`;
}

export function randomAvatarId() {
  return pick(AVATARS);
}
