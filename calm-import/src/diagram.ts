// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
export type ShapeHint =
  | 'rectangle'
  | 'rounded-rectangle'
  | 'cylinder'
  | 'ellipse'
  | 'diamond'
  | 'person'
  | 'cloud'
  | 'hexagon'
  | 'document'
  | 'parallelogram'
  | 'queue'
  | 'unknown';

/** Absolute page coordinates. */
export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Box {
  id: string;
  label: string;
  shape: ShapeHint;
  geometry: Geometry;
  containerId?: string;
  isContainer: boolean;
}

export interface Arrow {
  id: string;
  label: string;
  sourceId?: string;
  targetId?: string;
  /** 'start' arrows are already reversed by the reader. */
  heads: 'end' | 'start' | 'both' | 'none';
}

export interface Annotation {
  id: string;
  label: string;
  kind: 'note' | 'text' | 'legend' | 'image';
}

export interface Diagram {
  boxes: Box[];
  arrows: Arrow[];
  annotations: Annotation[];
  pageNames: string[];
  /** Which of pageNames was converted (draw.io: the first page with a diagram on it). Default 0. */
  page?: number;
}
