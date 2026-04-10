/**
 * Dense linear algebra utilities for the constraint solver.
 * LU decomposition with partial pivoting, and supporting routines.
 */

/** Solve Ax = b using LU decomposition with partial pivoting. Modifies A and b in place. */
export function solveLU(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  if (n === 0) return [];
  if (A.length !== n || A[0].length !== n) return null;

  // Copy to avoid destroying originals
  const LU = A.map(r => [...r]);
  const piv = Array.from({ length: n }, (_, i) => i);

  for (let k = 0; k < n; k++) {
    // Find pivot
    let maxVal = Math.abs(LU[k][k]);
    let maxRow = k;
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(LU[i][k]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = i;
      }
    }

    if (maxVal < 1e-14) {
      // Singular or near-singular — skip this column
      continue;
    }

    // Swap rows
    if (maxRow !== k) {
      [LU[k], LU[maxRow]] = [LU[maxRow], LU[k]];
      [piv[k], piv[maxRow]] = [piv[maxRow], piv[k]];
    }

    // Eliminate below
    for (let i = k + 1; i < n; i++) {
      LU[i][k] /= LU[k][k];
      for (let j = k + 1; j < n; j++) {
        LU[i][j] -= LU[i][k] * LU[k][j];
      }
    }
  }

  // Permute b
  const pb = new Array(n);
  for (let i = 0; i < n; i++) pb[i] = b[piv[i]];

  // Forward substitution (Ly = pb)
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      pb[i] -= LU[i][j] * pb[j];
    }
  }

  // Back substitution (Ux = y)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j < n; j++) {
      pb[i] -= LU[i][j] * pb[j];
    }
    if (Math.abs(LU[i][i]) < 1e-14) {
      pb[i] = 0; // singular row, set unknown to 0
    } else {
      pb[i] /= LU[i][i];
    }
  }

  return pb;
}

/**
 * Solve rectangular system J * dq = -c using minimum-norm least-squares.
 * J is m x n (m constraints, n free variables). When m < n (under-constrained),
 * uses pseudo-inverse via normal equations: dq = J^T (J J^T)^-1 (-c).
 * When m >= n, solves (J^T J + lambda*I) dq = J^T (-c) with Tikhonov.
 */
export function solveLinearSystem(
  Jdense: number[][],
  negC: number[],
  m: number,
  n: number
): number[] | null {
  if (m === 0) return new Array(n).fill(0);
  if (n === 0) return [];

  if (m === n) {
    // Square system — direct LU
    return solveLU(Jdense, negC);
  }

  if (m < n) {
    // Under-determined: dq = J^T * (J * J^T)^-1 * negC
    // Compute G = J * J^T (m x m)
    const G = Array.from({ length: m }, () => new Array(m).fill(0));
    for (let i = 0; i < m; i++) {
      for (let j = i; j < m; j++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += Jdense[i][k] * Jdense[j][k];
        G[i][j] = s;
        G[j][i] = s;
      }
      G[i][i] += 1e-10; // small regularization
    }

    const lambda = solveLU(G, [...negC]);
    if (!lambda) return null;

    // dq = J^T * lambda
    const dq = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < m; i++) {
        dq[j] += Jdense[i][j] * lambda[i];
      }
    }
    return dq;
  }

  // Over-determined: (J^T J + lambda*I) dq = J^T negC
  const reg = 1e-6;
  const JTJ = Array.from({ length: n }, () => new Array(n).fill(0));
  const JTb = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let k = 0; k < m; k++) s += Jdense[k][i] * Jdense[k][j];
      JTJ[i][j] = s;
      JTJ[j][i] = s;
    }
    JTJ[i][i] += reg;
    for (let k = 0; k < m; k++) {
      JTb[i] += Jdense[k][i] * negC[k];
    }
  }

  return solveLU(JTJ, JTb);
}

/** Compute the rank of a dense matrix via column-pivoted QR */
export function matrixRank(A: number[][], tol = 1e-8): number {
  const m = A.length;
  if (m === 0) return 0;
  const n = A[0].length;
  const R = A.map(r => [...r]);
  const minDim = Math.min(m, n);
  let rank = 0;

  for (let k = 0; k < minDim; k++) {
    // Find column with largest norm in remaining submatrix
    let maxNorm = 0;
    let maxCol = k;
    for (let j = k; j < n; j++) {
      let norm = 0;
      for (let i = k; i < m; i++) norm += R[i][j] * R[i][j];
      if (norm > maxNorm) { maxNorm = norm; maxCol = j; }
    }

    if (Math.sqrt(maxNorm) < tol) break;

    // Swap columns
    if (maxCol !== k) {
      for (let i = 0; i < m; i++) {
        [R[i][k], R[i][maxCol]] = [R[i][maxCol], R[i][k]];
      }
    }

    // Householder reflection
    let normCol = 0;
    for (let i = k; i < m; i++) normCol += R[i][k] * R[i][k];
    normCol = Math.sqrt(normCol);

    if (normCol < tol) break;

    const sign = R[k][k] >= 0 ? 1 : -1;
    const alpha = -sign * normCol;
    const v = new Array(m).fill(0);
    v[k] = R[k][k] - alpha;
    for (let i = k + 1; i < m; i++) v[i] = R[i][k];

    let vNorm = 0;
    for (let i = k; i < m; i++) vNorm += v[i] * v[i];
    if (vNorm < tol * tol) break;

    // Apply reflection to remaining columns
    for (let j = k; j < n; j++) {
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i] * R[i][j];
      const scale = 2 * dot / vNorm;
      for (let i = k; i < m; i++) R[i][j] -= scale * v[i];
    }

    rank++;
  }

  return rank;
}

/** Euclidean norm of a vector */
export function vecNorm(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}
