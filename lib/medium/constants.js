// Paragraph/markup constants for Medium's /p/{id}/deltas API.
// Verified against presskit-mcp session publish + live editor rendering.
// (medium-ops numeric labels differ — e.g. its "8=H3" is PRE in the editor.)
export const P_PARA = 1;
export const P_H1 = 2;
export const P_H2 = 3; // story title + ## section headings (large T)
export const P_IMG = 4;
export const P_BLOCKQUOTE = 6;
export const P_PRE = 8;
export const P_ULI = 9;
export const P_H3 = 13; // ### and h4–h6 (small T / graf--h4)
export const P_OLI = 10;
export const P_HR = 15;

export const M_BOLD = 1;
export const M_ITALIC = 2;
export const M_LINK = 3;
export const M_CODE = 10;
export const M_STRIKE = 11;

export const TAG_TO_PARA = {
  p: P_PARA,
  h1: P_H1,
  h2: P_H2,
  h3: P_H3,
  h4: P_H3,
  h5: P_H3,
  h6: P_H3,
};
