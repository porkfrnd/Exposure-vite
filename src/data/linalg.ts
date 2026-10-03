/**
 * Minimal dense linear algebra, hand-written (no external dependency).
 *
 * Only what the Bayesian multiplier update and the Gaussian-process posterior
 * actually need: small SPD solves via Cholesky, matrix/vector products and a few
 * reductions. n is tiny (a handful of observations), so clarity beats asymptotics.
 *
 * Everything is defensive: a non-finite input is coerced to 0 and a failed
 * Cholesky falls back to Gaussian elimination with partial pivoting, so the data
 * layer can never propagate NaN into the UI (AC-10).
 */

/** Dense matrix as number[][] (row-major). */
export type Matrix = number[][];

export function zeros(n: number, m: number): Matrix {
  return Array.from({ length: n }, () => new Array<number>(m).fill(0));
}

export function identity(n: number): Matrix {
  const out = zeros(n, n);
  for (let i = 0; i < n; i++) out[i][i] = 1;
  return out;
}

/** Replace non-finite entries with `fallback` so arithmetic stays defined. */
export function sanitize(a: number, fallback = 0): number {
  return Number.isFinite(a) ? a : fallback;
}

export function matVec(A: Matrix, v: number[]): number[] {
  const out = new Array<number>(A.length).fill(0);
  for (let i = 0; i < A.length; i++) {
    let sum = 0;
    for (let j = 0; j < v.length; j++) sum += sanitize(A[i][j]) * sanitize(v[j]);
    out[i] = sum;
  }
  return out;
}

export function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sanitize(a[i]) * sanitize(b[i]);
  return sum;
}

export function transpose(A: Matrix): Matrix {
  const rows = A.length;
  const cols = rows > 0 ? A[0].length : 0;
  const out = zeros(cols, rows);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) out[j][i] = sanitize(A[i][j]);
  }
  return out;
}

/**
 * Cholesky factorisation A = L·Lᵀ for a symmetric positive-definite A.
 * Returns null when A is not positive definite.
 *
 * `jitter` is added to the diagonal before factorising, which is the standard
 * regularisation for a kernel matrix built from near-duplicate points.
 */
export function cholesky(A: Matrix, jitter = 0): Matrix | null {
  const n = A.length;
  if (n === 0) return zeros(0, 0);
  const L = zeros(n, n);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = sanitize(A[i][j]) + (i === j ? jitter : 0);
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (!Number.isFinite(sum) || sum <= 0) return null;
        L[i][j] = Math.sqrt(sum);
      } else {
        const diag = L[j][j];
        if (!Number.isFinite(diag) || diag === 0) return null;
        L[i][j] = sum / diag;
      }
    }
  }
  return L;
}

/** Solve A·x = b given its Cholesky factor. */
export function choleskySolve(L: Matrix, b: number[]): number[] {
  const n = L.length;
  if (n === 0) return [];

  // Forward substitution: L·y = b
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = sanitize(b[i]);
    for (let k = 0; k < i; k++) sum -= L[i][k] * y[k];
    y[i] = L[i][i] === 0 ? 0 : sum / L[i][i];
  }

  // Back substitution: Lᵀ·x = y
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
    x[i] = L[i][i] === 0 ? 0 : sum / L[i][i];
  }
  return x.map((v) => (Number.isFinite(v) ? v : 0));
}

/** log|K| from its Cholesky factor: 2·Σ log L[i][i]. */
export function choleskyLogDet(L: Matrix): number {
  let sum = 0;
  for (let i = 0; i < L.length; i++) {
    const d = L[i][i];
    if (!Number.isFinite(d) || d <= 0) return Number.NEGATIVE_INFINITY;
    sum += Math.log(d);
  }
  return 2 * sum;
}

/**
 * Solve A·x = b for a general square A. Tries Cholesky first (fast and stable),
 * then Gaussian elimination with partial pivoting, and finally returns zeros.
 * Returning zeros rather than throwing keeps the UI finite on a degenerate input.
 */
export function solve(A: Matrix, b: number[], jitter = 1e-10): number[] {
  const n = A.length;
  if (n === 0) return [];

  const L = cholesky(A, jitter);
  if (L) return choleskySolve(L, b);
  return gaussianSolve(A, b);
}

function gaussianSolve(A: Matrix, b: number[]): number[] {
  const n = A.length;
  const M = A.map((row) => row.map((v) => sanitize(v)));
  const x = b.map((v) => sanitize(v));

  for (let col = 0; col < n; col++) {
    // Partial pivot.
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-14) continue; // singular column: leave at 0

    if (pivot !== col) {
      const tmpRow = M[pivot];
      M[pivot] = M[col];
      M[col] = tmpRow;
      const tmpVal = x[pivot];
      x[pivot] = x[col];
      x[col] = tmpVal;
    }

    const p = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / p;
      if (factor === 0) continue;
      for (let c = col; c < n; c++) M[r][c] -= factor * M[col][c];
      x[r] -= factor * x[col];
    }
  }

  // Back substitution.
  const out = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = x[i];
    for (let k = i + 1; k < n; k++) sum -= M[i][k] * out[k];
    out[i] = M[i][i] === 0 ? 0 : sum / M[i][i];
  }
  return out.map((v) => (Number.isFinite(v) ? v : 0));
}

/** Matrix inverse via the normal equations on a solve with unit columns. */
export function invert(A: Matrix): Matrix {
  const n = A.length;
  const out = zeros(n, n);
  for (let i = 0; i < n; i++) {
    const e = new Array<number>(n).fill(0);
    e[i] = 1;
    const col = solve(A, e);
    for (let r = 0; r < n; r++) out[r][i] = col[r];
  }
  return out;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += sanitize(v);
  return sum / values.length;
}

export function median(values: number[]): number {
  const vs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (vs.length === 0) return 0;
  const mid = vs.length >> 1;
  return vs.length % 2 === 1 ? vs[mid] : (vs[mid - 1] + vs[mid]) / 2;
}