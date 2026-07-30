export type RGB = {
  b: number,
  g: number,
  r: number,
}

export type Gradient = {
  end: RGB
  start: RGB,
}

export const SFPM_BLUE: RGB     = {b: 255, g: 127, r: 61};
export const SFPM_RED:  RGB     = {b: 102, g: 51,  r: 255};

export const SFPM_GRADIENT: Gradient = {end: SFPM_RED, start: SFPM_BLUE};
