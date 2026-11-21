export const icons = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  plug: "M9 3v5m6-5v5M7 8h10v4a5 5 0 0 1-10 0z M12 17v4",
  settings: "M4 6h16 M4 12h16 M4 18h16 M8 4v4 M16 10v4 M10 16v4",
  expandPanel: "M3 4h18v16H3z M8 4v16 m4-11 3 3-3 3",
  collapsePanel: "M3 4h18v16H3z M8 4v16 m7-11-3 3 3 3",
  plus: "M12 5v14 M5 12h14",
  ellipsis: "M5 12h.5 M11.75 12h.5 M18.5 12h.5",
  arrow: "M6 18 18 6 M6 6h12v12",
  chevron: "m9 5 7 7-7 7",
  search: "M21 21 16.5 16.5 M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
  refresh:
    "M20 7v5h-5 M4 17v-5h5 M6.1 6.1a8 8 0 0 1 13.3 3 M4.6 14.9a8 8 0 0 0 13.3 3",
  bot: "M12 3v3 M8 3h4 M5 6h14v14H5z M2 10v6 M22 10v6 M9 11v2 M15 11v2 M9 17h6",
  shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z m-4 9 3 3 5-6",
  check: "m5 12 4 4L19 6",
  clock: "M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  alert: "M12 8v5 M12 17h.01 M10 3h4l9 17H1z",
  terminal: "m5 7 5 5-5 5 M13 17h6",
  close: "m6 6 12 12 M18 6 6 18",
  activity: "M2 12h4l4-9 4 18 4-9h4",
  logout: "M9 4H4v16h5 M14 8l4 4-4 4 M8 12h13",
} as const;
export type IconName = keyof typeof icons;
