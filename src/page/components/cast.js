const CHARACTERS = {
  pokemon: [
    {
      name: "Pikachu",
      fur: "#e8b923",
      palette: { Y: "#f6d23c", K: "#1b1b1f", R: "#e5533d", T: "#c98a1e", B: "#8a5a2b" },
      rows: [
        "..K..........K...",
        "..KY........YK...",
        "...YY.YYYYY.YY...",
        "...YYYYYYYYYY....",
        "...YYYYYYYYYY....",
        "...YRYYYYYYRY....",
        "...YYYYYYYYYY....",
        "....YYYYYYYY..TT.",
        "....YYYYYYYY.TT..",
        "....YYYYYYYYTT...",
        "....YYYYYYYYB....",
        "....YYYYYYYY.....",
        "....YYYYYYYY.....",
        "....YY....YY.....",
      ],
    },
    {
      name: "Charmander",
      fur: "#e07a2e",
      palette: { O: "#f08a3c", C: "#f7d58f", F: "#e5402d", Y: "#ffc93c" },
      rows: [
        ".................",
        ".................",
        "....OOOOOOOO.....",
        "...OOOOOOOOOO....",
        "...OOOOOOOOOO....",
        "...OOOOOOOOOO....",
        "...OOOOOOOOOO....",
        "....OOOOOOOO...F.",
        "....OCCCCCCO..FYF",
        "....OCCCCCCO..OF.",
        "....OCCCCCCO.OO..",
        "....OCCCCCCOOO...",
        "....OOOOOOOO.....",
        "....OO....OO.....",
      ],
    },
    {
      name: "Squirtle",
      fur: "#6cb8d8",
      palette: { B: "#7cc6e6", S: "#a8673a", C: "#f3dc9a" },
      rows: [
        ".................",
        ".................",
        "....BBBBBBBB.....",
        "...BBBBBBBBBB....",
        "...BBBBBBBBBB....",
        "...BBBBBBBBBB....",
        "...BBBBBBBBBB....",
        "....BBBBBBBB.....",
        "...SCCCCCCCCS....",
        "...SCCCCCCCCS.BB.",
        "...SCCCCCCCCSBB..",
        "...SCCCCCCCCS....",
        "....SSSSSSSS.....",
        "....BB....BB.....",
      ],
    },
    {
      name: "Bulbasaur",
      fur: "#5fb59a",
      palette: { G: "#74c9ad", D: "#3f8f78", L: "#4f9e3c" },
      rows: [
        ".......LL........",
        "...G..LLLLL..G...",
        "...GGGGGGGGGG....",
        "...GGGGGGGGGG....",
        "...GGGGGGGGGG....",
        "...GGGGGGGGGG....",
        "...GGDGGGGDGG....",
        "....GGGGGGGG.....",
        "...LGGGGGGGGL....",
        "..LLGGDGGDGGLL...",
        "...LGGGGGGGGL....",
        "....GGGGGGGG.....",
        "....GGGGGGGG.....",
        "....GG....GG.....",
      ],
    },
    {
      name: "Jigglypuff",
      fur: "#f39cbc",
      palette: { P: "#f7b3cc" },
      rows: [
        ".................",
        ".......PP........",
        "..P..PPPPPP..P...",
        "..PPPPPPPPPPPP...",
        "..PPPPPPPPPPPP...",
        "..PPPPPPPPPPPP...",
        "..PPPPPPPPPPPP...",
        "..PPPPPPPPPPPP...",
        "..PPPPPPPPPPPP...",
        "...PPPPPPPPPP....",
        "...PPPPPPPPPP....",
        "....PPPPPPPP.....",
        "....PPPPPPPP.....",
        ".....PP..PP......",
      ],
    },
    {
      name: "Eevee",
      fur: "#a8733f",
      palette: { E: "#b7834d", C: "#f2e2bf" },
      rows: [
        ".EE..........EE..",
        ".EEE........EEE..",
        "..EEEEEEEEEEEE...",
        "...EEEEEEEEEE....",
        "...EEEEEEEEEE....",
        "...EEEEEEEEEE....",
        "...EEEEEEEEEE....",
        "...CCEEEEEECC....",
        "...CCCCCCCCCC.EE.",
        "....CCCCCCCC.ECE.",
        "....EEEEEEEE.EEC.",
        "....EEEEEEEEEEE..",
        "....EEEEEEEE.....",
        "....EE....EE.....",
      ],
    },
  ],
  starwars: [
    {
      name: "Yoda",
      fur: "#8db35a",
      palette: { G: "#9cc46a", W: "#d9d9d0", R: "#8a6a48", L: "#b39572" },
      rows: [
        ".................",
        ".................",
        "....GWGGGGWG.....",
        "GGGGGGGGGGGGGGGG.",
        ".GGGGGGGGGGGGGG..",
        "...GGGGGGGGGG....",
        "...GGGGGGGGGG....",
        "....GGGGGGGG.....",
        "...RRRRRRRRRR....",
        "...RRRLLLLRRR....",
        "...RRRRRRRRRR....",
        "...RRRRRRRRRR....",
        "...RRRRRRRRRR....",
        "....GG....GG.....",
      ],
    },
    {
      name: "R2-D2",
      eyes: false,
      arms: false,
      palette: { S: "#b8c0c8", B: "#2f6fd0", W: "#f2f4f6", K: "#1b1b1f", R: "#e5402d" },
      rows: [
        ".................",
        ".....SSSSSS......",
        "....SSSSSSSS.....",
        "...SSBBSSKKSS....",
        "...SSSSSSRSSS....",
        "...BBBBBBBBBB....",
        "...WWWWWWWWWW....",
        "...WBBWWWWBBW....",
        "...WBBWWWWBBW....",
        "...WWWBBBBWWW....",
        "...WWWBWWBWWW....",
        "...WWWWWWWWWW....",
        "..WWW......WWW...",
        "..SSS......SSS...",
      ],
    },
    {
      name: "C-3PO",
      fur: "#d9a93a",
      palette: { Y: "#e8bc4a", D: "#a87d22" },
      rows: [
        ".................",
        ".....YYYYYY......",
        "....YYYYYYYY.....",
        "....YYYYYYYY.....",
        "....YYYYYYYY.....",
        "....YYDDDDYY.....",
        ".....YYYYYY......",
        "......DDDD.......",
        "...YYYYYYYYYY....",
        "...YYYDDDDYYY....",
        "....YYYYYYYY.....",
        "....DDDDDDDD.....",
        "....YYY..YYY.....",
        "....YYY..YYY.....",
      ],
    },
    {
      name: "Chewbacca",
      fur: "#7a5233",
      palette: { C: "#8f6440", D: "#5e3f26", K: "#1b1b1f", S: "#b9b9b0" },
      rows: [
        ".................",
        "....DDDDDDDD.....",
        "...DCCCCCCCCD....",
        "...DCCCCCCCCD....",
        "...DCCCCCCCCD....",
        "...DCCCKKCCCD....",
        "...DCCCCCCCCD....",
        "...DDCCCCCCDD....",
        "...CCCCCCCSSC....",
        "...CCCCCCSSCC....",
        "...CCCCCSSCCC....",
        "...CCCCSSCCCC....",
        "...CCCCCCCCCC....",
        "....DD....DD.....",
      ],
    },
    {
      name: "Stormtrooper",
      fur: "#e9ecef",
      eyes: false,
      palette: { W: "#f4f6f8", K: "#1b1b1f", G: "#9aa3ad" },
      rows: [
        ".................",
        ".....WWWWWW......",
        "....WWWWWWWW.....",
        "....WKKWWKKW.....",
        "....WKKWWKKW.....",
        "....WWWKKWWW.....",
        "....GWKWWKWG.....",
        ".....WWWWWW......",
        "...WWWWWWWWWW....",
        "...WWKKKKKKWW....",
        "...WWWWWWWWWW....",
        "....KKKKKKKK.....",
        "....WWW..WWW.....",
        "....WWW..WWW.....",
      ],
    },
    {
      name: "Darth Vader",
      fur: "#2a2a30",
      eyes: false,
      palette: { K: "#1d1d22", G: "#6b7079", R: "#e5402d", B: "#3d7be0" },
      rows: [
        "......KKKKK......",
        "....KKKKKKKKK....",
        "...KKKKKKKKKKK...",
        "...KKGGKKKGGKK...",
        "...KKKKGGKKKKK...",
        "..KKKKGKKGKKKKK..",
        "..KKKKGGGGKKKKK..",
        ".KKKKKKKKKKKKKKK.",
        ".KKKKKKKKKKKKKKK.",
        ".KKKGRBGKKKKKKKK.",
        ".KKKKKKKKKKKKKKK.",
        ".KKKKGGGGKKKKKKK.",
        ".KKKKKKKKKKKKKKK.",
        "..KKK......KKK...",
      ],
    },
  ],
};

export const CASTS = [
  { id: "nutrias", label: "Nutrias" },
  { id: "pokemon", label: "Pokémon" },
  { id: "starwars", label: "Star Wars" },
];

const KEY = "tower-cast";

export function currentCast() {
  try {
    const v = localStorage.getItem(KEY);
    return CHARACTERS[v] ? v : "nutrias";
  } catch (e) {
    return "nutrias";
  }
}

export function setCast(id) {
  try {
    if (id === "nutrias") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch (e) {}
}

function toRects({ rows, palette }) {
  let out = "";
  rows.forEach((row, i) => {
    const y = i - 1;
    for (let x = 0; x < row.length; ) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      if (palette[ch]) out += `<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${palette[ch]}"/>`;
      x = end;
    }
  });
  return out;
}

const drawn = {};

export function characterFor(seed) {
  const cast = currentCast();
  const list = CHARACTERS[cast];
  if (!list) return null;
  const c = list[seed % list.length];
  const key = `${cast}:${c.name}`;
  if (!drawn[key]) drawn[key] = toRects(c);
  return { name: c.name, fur: c.fur || "#9aa3ad", eyes: c.eyes !== false, arms: c.arms !== false, body: drawn[key] };
}
