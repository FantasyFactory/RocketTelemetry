import React, { useState, useEffect, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

// Definizione delle interfacce per i tipi di dati
interface SensorDataPoint {
  timestamp: number;
  relativeTime: number;
  accelX: number;
  accelY: number;
  accelZ: number;
  gyroX: number;
  gyroY: number;
  gyroZ: number;
  altitude: number;
  roll?: number;
  pitch?: number;
  yaw?: number;
  compAccelX?: number;
  compAccelY?: number;
  compAccelZ?: number;
}

// Definizione del tipo di filtro
type FilterType = 'complementary' | 'kalman' | 'madgwick';

interface ApiResponse {
  sensors: {
    accel: {
      x: number;
      y: number;
      z: number;
    };
    gyro: {
      x: number;
      y: number;
      z: number;
    };
    altitude?: number;
  };
  system: {
    millis: number;
  };
}


// Implementazione del filtro complementare per la fusione dei dati
const applyComplementaryFilter = (data: SensorDataPoint[], alpha = 0.98): SensorDataPoint[] => {
  if (!data || data.length === 0) return [];
  
  const result = [...data];
  let roll = 0;
  let pitch = 0;
  let yaw = 0;
  
  // Inizializzazione con i primi valori dell'accelerometro
  const firstPoint = data[0];
  // Roll (rotazione attorno all'asse X)
  roll = Math.atan2(firstPoint.accelY, firstPoint.accelZ) * (180 / Math.PI);
  // Pitch (rotazione attorno all'asse Y)
  pitch = Math.atan2(-firstPoint.accelX, Math.sqrt(firstPoint.accelY * firstPoint.accelY + firstPoint.accelZ * firstPoint.accelZ)) * (180 / Math.PI);
  
  // Calcola il dt (intervallo di tempo) tra campioni consecutivi
  const calculateDt = (current: SensorDataPoint, previous: SensorDataPoint | null): number => {
    if (!previous) return 0.1; // Default a 100ms se non c'è un punto precedente
    
    // Utilizziamo il timestamp relativo per calcolare dt
    if (current.relativeTime !== undefined && previous.relativeTime !== undefined) {
      return current.relativeTime - previous.relativeTime;
    }
    
    // Fallback al timestamp del sistema
    return (current.timestamp - previous.timestamp) / 1000; // Converti in secondi
  };
  
  for (let i = 0; i < result.length; i++) {
    const point = result[i];
    const prevPoint = i > 0 ? result[i-1] : null;
    const dt = calculateDt(point, prevPoint);
    
    // Calcolo dell'angolo basato sull'accelerometro
    const accelRoll = Math.atan2(point.accelY, point.accelZ) * (180 / Math.PI);
    const accelPitch = Math.atan2(-point.accelX, Math.sqrt(point.accelY * point.accelY + point.accelZ * point.accelZ)) * (180 / Math.PI);
    
    // Integrazione del giroscopio
    if (i > 0) {
      // Limita dt a un valore massimo ragionevole per evitare salti eccessivi
      const limitedDt = Math.min(dt, 0.5);
      
      roll = alpha * (roll + point.gyroX * limitedDt) + (1 - alpha) * accelRoll;
      pitch = alpha * (pitch + point.gyroY * limitedDt) + (1 - alpha) * accelPitch;
      yaw = (yaw + point.gyroZ * limitedDt); // Il giroscopio è l'unica fonte per lo yaw
      
      // Mantieni yaw nel range -180 a 180
      while (yaw > 180) yaw -= 360;
      while (yaw < -180) yaw += 360;
    }
    
    // Salvataggio degli angoli filtrati
    result[i].roll = roll;
    result[i].pitch = pitch;
    result[i].yaw = yaw;
  }
  
  return result;
};

// Implementazione migliorata del filtro complementare per la fusione dei dati
// con compensazione della posizione del sensore rispetto al centro di massa
const applyImprovedComplementaryFilter = (data: SensorDataPoint[], alpha = 0.98): SensorDataPoint[] => {
  if (!data || data.length === 0) return [];
  
  const result = [...data];
  let roll = 0;
  let pitch = 0;
  let yaw = 0;
  
  // Distanza del sensore dal centro di massa (in metri)
  // Questo valore dovrebbe essere calibrato in base al razzo specifico
  const distanceFromCM = 0.030; // 30 cm di esempio, regolare in base al razzo reale
  
  // Vettore di posizione del sensore rispetto al CM nel sistema di coordinate del corpo (razzo)
  // Assumendo che il sensore sia posizionato sull'asse longitudinale del razzo, verso la punta
  // [x, y, z] in cui z è lungo l'asse del razzo, positivo verso la punta
  const sensorPositionVector = [0, 0, distanceFromCM];
  
  // Inizializzazione con i primi valori dell'accelerometro
  const firstPoint = data[0];
  
  // Compensiamo le letture iniziali dell'accelerometro per la posizione del sensore
  // In posizione statica, questo compensa principalmente l'effetto della gravità
  const initialAccel = compensateAcceleration(
    firstPoint.accelX, 
    firstPoint.accelY, 
    firstPoint.accelZ,
    0, 0, 0, // velocità angolari iniziali
    0, 0, 0, // accelerazioni angolari iniziali (sconosciute)
    sensorPositionVector
  );
  
  // Calcolo iniziale degli angoli usando i valori compensati
  roll = Math.atan2(initialAccel.y, initialAccel.z) * (180 / Math.PI);
  pitch = Math.atan2(-initialAccel.x, Math.sqrt(initialAccel.y * initialAccel.y + initialAccel.z * initialAccel.z)) * (180 / Math.PI);
  
  // Calcolo del dt e memoria dello stato precedente per le accelerazioni angolari
  let prevGyroX = firstPoint.gyroX;
  let prevGyroY = firstPoint.gyroY;
  let prevGyroZ = firstPoint.gyroZ;
  
  // Calcola il dt (intervallo di tempo) tra campioni consecutivi
  const calculateDt = (current: SensorDataPoint, previous: SensorDataPoint | null): number => {
    if (!previous) return 0.1; // Default a 100ms se non c'è un punto precedente
    
    // Utilizziamo il timestamp relativo per calcolare dt
    if (current.relativeTime !== undefined && previous.relativeTime !== undefined) {
      return current.relativeTime - previous.relativeTime;
    }
    
    // Fallback al timestamp del sistema
    return (current.timestamp - previous.timestamp) / 1000; // Converti in secondi
  };
  
  for (let i = 0; i < result.length; i++) {
    const point = result[i];
    const prevPoint = i > 0 ? result[i-1] : null;
    const dt = calculateDt(point, prevPoint);
    
    // Calcolo delle accelerazioni angolari usando le differenze finite
    // Nota: questo è un calcolo approssimativo, un filtro di Kalman sarebbe più preciso
    const angAccelX = (point.gyroX - prevGyroX) / dt; // rad/s^2
    const angAccelY = (point.gyroY - prevGyroY) / dt;
    const angAccelZ = (point.gyroZ - prevGyroZ) / dt;
    
    // Memorizza i valori correnti del giroscopio per il prossimo ciclo
    prevGyroX = point.gyroX;
    prevGyroY = point.gyroY;
    prevGyroZ = point.gyroZ;
    
    // Compensazione dell'accelerazione dovuta alla posizione del sensore
    const compensatedAccel = compensateAcceleration(
      point.accelX,
      point.accelY,
      point.accelZ,
      point.gyroX, point.gyroY, point.gyroZ, // velocità angolari
      angAccelX, angAccelY, angAccelZ,       // accelerazioni angolari
      sensorPositionVector
    );
    
    // Calcolo dell'angolo basato sull'accelerometro compensato
    const accelRoll = Math.atan2(compensatedAccel.y, compensatedAccel.z) * (180 / Math.PI);
    const accelPitch = Math.atan2(-compensatedAccel.x, Math.sqrt(compensatedAccel.y * compensatedAccel.y + compensatedAccel.z * compensatedAccel.z)) * (180 / Math.PI);
    
    // Integrazione del giroscopio
    if (i > 0) {
      // Limita dt a un valore massimo ragionevole per evitare salti eccessivi
      const limitedDt = Math.min(dt, 0.5);
      
      // Applicazione del filtro complementare con le accelerazioni compensate
      roll = alpha * (roll + point.gyroX * limitedDt) + (1 - alpha) * accelRoll;
      pitch = alpha * (pitch + point.gyroY * limitedDt) + (1 - alpha) * accelPitch;
      yaw = (yaw + point.gyroZ * limitedDt); // Il giroscopio è l'unica fonte per lo yaw
      
      // Mantieni yaw nel range -180 a 180
      while (yaw > 180) yaw -= 360;
      while (yaw < -180) yaw += 360;
    }
    
    // Salvataggio degli angoli filtrati
    result[i].roll = roll;
    result[i].pitch = pitch;
    result[i].yaw = yaw;
    
    // Opzionale: salvare anche le accelerazioni compensate per analisi
    result[i].compAccelX = compensatedAccel.x;
    result[i].compAccelY = compensatedAccel.y;
    result[i].compAccelZ = compensatedAccel.z;
  }
  
  return result;
};

/**
 * Funzione che compensa le letture dell'accelerometro per la posizione del sensore IMU
 * relativamente al centro di massa del razzo.
 * 
 * Formula di base: a_cm = a_imu - (ω × (ω × r) + α × r)
 * dove:
 * - a_cm è l'accelerazione del centro di massa
 * - a_imu è l'accelerazione misurata dal sensore
 * - ω è il vettore di velocità angolare (dal giroscopio)
 * - α è il vettore di accelerazione angolare (derivata di ω)
 * - r è il vettore di posizione del sensore rispetto al centro di massa
 * - × rappresenta il prodotto vettoriale
 */
function compensateAcceleration(
  accelX: number, accelY: number, accelZ: number,   // Accelerazioni misurate (m/s^2 o g)
  gyroX: number, gyroY: number, gyroZ: number,      // Velocità angolari (rad/s)
  angAccelX: number, angAccelY: number, angAccelZ: number, // Accelerazioni angolari (rad/s^2)
  sensorPosition: number[]                         // Posizione del sensore rispetto al CM [x,y,z]
) {
  const [rx, ry, rz] = sensorPosition;
  
  // Calcolo delle accelerazioni centripete: ω × (ω × r)
  // Prodotto vettoriale ω × r
  const wxr_x = gyroY * rz - gyroZ * ry;
  const wxr_y = gyroZ * rx - gyroX * rz;
  const wxr_z = gyroX * ry - gyroY * rx;
  
  // Prodotto vettoriale ω × (ω × r)
  const centripetal_x = gyroY * wxr_z - gyroZ * wxr_y;
  const centripetal_y = gyroZ * wxr_x - gyroX * wxr_z;
  const centripetal_z = gyroX * wxr_y - gyroY * wxr_x;
  
  // Calcolo dell'accelerazione tangenziale: α × r
  const tangential_x = angAccelY * rz - angAccelZ * ry;
  const tangential_y = angAccelZ * rx - angAccelX * rz;
  const tangential_z = angAccelX * ry - angAccelY * rx;
  
  // Somma delle componenti di accelerazione
  const totalRotationalEffect_x = centripetal_x + tangential_x;
  const totalRotationalEffect_y = centripetal_y + tangential_y;
  const totalRotationalEffect_z = centripetal_z + tangential_z;
  
  // Compensazione dell'accelerazione misurata
  // a_cm = a_imu - effetti rotazionali
  return {
    x: accelX - totalRotationalEffect_x,
    y: accelY - totalRotationalEffect_y,
    z: accelZ - totalRotationalEffect_z
  };
}


// Implementazione del filtro di Kalman per la fusione dei dati IMU
// Questo filtro è più complesso ma offre una stima ottimale dello stato in presenza di rumore
// e incertezze nelle misurazioni.
const applyKalmanFilter = (data: SensorDataPoint[]): SensorDataPoint[] => {
  if (!data || data.length === 0) return [];
  
  const result = [...data];
  
  // Stati del filtro di Kalman (6 stati: roll, pitch, yaw e loro derivate)
  // x = [roll, pitch, yaw, roll_rate, pitch_rate, yaw_rate]
  let x = new Array(6).fill(0);
  
  // Matrice di covarianza: rappresenta l'incertezza nella stima dello stato
  // Inizializziamo con valori alti sulla diagonale per indicare alta incertezza iniziale
  let P = Array(6).fill(0).map(() => Array(6).fill(0));
  for (let i = 0; i < 6; i++) {
    P[i][i] = i < 3 ? 1000 : 100; // Maggiore incertezza per angoli, minore per velocità angolari
  }
  
  // Parametri del rumore di processo e di misurazione
  // Questi valori dovrebbero essere calibrati in base al sensore specifico
  // Rumore di processo: incertezza nel modello di evoluzione dello stato
  const processNoise = 0.01;
  // Rumore di misurazione: incertezza nelle misurazioni dell'accelerometro/giroscopio
  const measurementNoiseAccel = 0.1; // accelerometro (più rumoroso)
  const measurementNoiseGyro = 0.01; // giroscopio (meno rumoroso a breve termine)
  
  // Matrice del rumore di processo Q (6x6)
  let Q = Array(6).fill(0).map(() => Array(6).fill(0));
  for (let i = 0; i < 6; i++) {
    Q[i][i] = processNoise;
  }
  
  // Matrice del rumore di misurazione R (6x6)
  let R = Array(6).fill(0).map(() => Array(6).fill(0));
  for (let i = 0; i < 3; i++) {
    R[i][i] = measurementNoiseAccel; // Per le misurazioni dell'accelerometro (angoli)
  }
  for (let i = 3; i < 6; i++) {
    R[i][i] = measurementNoiseGyro; // Per le misurazioni del giroscopio (velocità angolari)
  }
  
  // Matrice di transizione dello stato F (6x6)
  // Per il primo punto, inizializziamo F come matrice identità
  let F: number[][] = Array(6).fill(0).map((_, i) => Array(6).fill(0).map((_, j) => i === j ? 1 : 0));

  
  // Matrice di osservazione H (6x6)
  // In questo caso semplice, assumiamo che misuriamo direttamente gli stati
  let H = Array(6).fill(0).map((_, i) => Array(6).fill(0).map((_, j) => i === j ? 1 : 0));
  
  // Inizializziamo con i primi valori dall'accelerometro
  const firstPoint = data[0];
  // Roll, Pitch dalle misurazioni dell'accelerometro
  x[0] = Math.atan2(firstPoint.accelY, firstPoint.accelZ) * (180 / Math.PI); // Roll
  x[1] = Math.atan2(-firstPoint.accelX, Math.sqrt(firstPoint.accelY * firstPoint.accelY + firstPoint.accelZ * firstPoint.accelZ)) * (180 / Math.PI); // Pitch
  // Yaw inizializzato a 0 (non è direttamente osservabile dall'accelerometro)
  x[2] = 0;
  // Velocità angolari inizializzate dai valori del giroscopio
  x[3] = firstPoint.gyroX; // Roll rate
  x[4] = firstPoint.gyroY; // Pitch rate
  x[5] = firstPoint.gyroZ; // Yaw rate
  
  // Salva gli angoli iniziali
  result[0].roll = x[0];
  result[0].pitch = x[1];
  result[0].yaw = x[2];
  
  // Funzione per calcolare il dt tra due punti
  const calculateDt = (current: SensorDataPoint, previous: SensorDataPoint | null): number => {
    if (!previous) return 0.1; // Default a 100ms se non c'è un punto precedente
    
    // Utilizziamo il timestamp relativo per calcolare dt
    if (current.relativeTime !== undefined && previous.relativeTime !== undefined) {
      return current.relativeTime - previous.relativeTime;
    }
    
    // Fallback al timestamp del sistema
    return (current.timestamp - previous.timestamp) / 1000; // Converti in secondi
  };
  
  // Loop principale del filtro di Kalman
  for (let i = 1; i < result.length; i++) {
    const point = result[i];
    const prevPoint = result[i-1];
    const dt = calculateDt(point, prevPoint);
    
    // Limita dt a un valore massimo ragionevole per evitare salti eccessivi
    const limitedDt = Math.min(dt, 0.5);
    
    // Aggiorna la matrice di transizione dello stato F con il dt attuale
    // La matrice F modella come lo stato evolve nel tempo
    // Per un sistema con angoli e velocità angolari:
    // [roll]       = [1, 0, 0, dt, 0, 0] [roll]
    // [pitch]      = [0, 1, 0, 0, dt, 0] [pitch]
    // [yaw]        = [0, 0, 1, 0, 0, dt] [yaw]
    // [roll_rate]  = [0, 0, 0, 1, 0, 0]  [roll_rate]
    // [pitch_rate] = [0, 0, 0, 0, 1, 0]  [pitch_rate]
    // [yaw_rate]   = [0, 0, 0, 0, 0, 1]  [yaw_rate]
    F[0][3] = limitedDt;
    F[1][4] = limitedDt;
    F[2][5] = limitedDt;
    
    // 1. Predizione: proietta lo stato e la covarianza in avanti nel tempo
    // x = F * x
    const x_pred = multiplyMatrixVector(F, x);
    
    // P = F * P * F^T + Q
    const FP = multiplyMatrices(F, P);
    const FT = transposeMatrix(F);
    const FPFT = multiplyMatrices(FP, FT);
    const P_pred = addMatrices(FPFT, Q);
    
    // 2. Ottieni le misurazioni
    // Calcolo degli angoli dall'accelerometro
    const accelRoll = Math.atan2(point.accelY, point.accelZ) * (180 / Math.PI);
    const accelPitch = Math.atan2(-point.accelX, Math.sqrt(point.accelY * point.accelY + point.accelZ * point.accelZ)) * (180 / Math.PI);
    
    // Vettore delle misurazioni z
    // z = [accelRoll, accelPitch, yaw_stimato, gyroX, gyroY, gyroZ]
    const z = [
      accelRoll,              // Roll dall'accelerometro
      accelPitch,             // Pitch dall'accelerometro
      x_pred[2] + point.gyroZ * limitedDt, // Yaw stimato (integrato dal giroscopio)
      point.gyroX,            // Roll rate dal giroscopio
      point.gyroY,            // Pitch rate dal giroscopio
      point.gyroZ             // Yaw rate dal giroscopio
    ];
    
    // 3. Aggiornamento: incorpora le nuove misurazioni
    // y = z - H * x_pred (residuo/innovazione)
    const Hx = multiplyMatrixVector(H, x_pred);
    const y = z.map((val, idx) => val - Hx[idx]);
    
    // S = H * P_pred * H^T + R (covarianza residua)
    const HP = multiplyMatrices(H, P_pred);
    const HT = transposeMatrix(H);
    const HPHT = multiplyMatrices(HP, HT);
    const S = addMatrices(HPHT, R);
    
    // K = P_pred * H^T * S^-1 (guadagno di Kalman)
    const S_inv = invertMatrix(S);
    const PHT = multiplyMatrices(P_pred, HT);
    const K = multiplyMatrices(PHT, S_inv);
    
    // x = x_pred + K * y (aggiornamento dello stato)
    const Ky = multiplyMatrixVector(K, y);
    x = x_pred.map((val, idx) => val + Ky[idx]);
    
    // P = (I - K * H) * P_pred (aggiornamento della covarianza)
    const I = Array(6).fill(0).map((_, i) => Array(6).fill(0).map((_, j) => i === j ? 1 : 0));
    const KH = multiplyMatrices(K, H);
    const I_KH = subtractMatrices(I, KH);
    P = multiplyMatrices(I_KH, P_pred);
    
    // Normalizza gli angoli nel range -180 a 180
    while (x[0] > 180) x[0] -= 360;
    while (x[0] < -180) x[0] += 360;
    while (x[1] > 180) x[1] -= 360;
    while (x[1] < -180) x[1] += 360;
    while (x[2] > 180) x[2] -= 360;
    while (x[2] < -180) x[2] += 360;
    
    // Salva i risultati
    result[i].roll = x[0];
    result[i].pitch = x[1];
    result[i].yaw = x[2];
  }
  
  return result;
};

// Funzioni di supporto per l'algebra lineare utilizzate nel filtro di Kalman

// Moltiplicazione matrice-vettore
function multiplyMatrixVector(A: number[][], v: number[]): number[] {
  const result = new Array(A.length).fill(0);
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < v.length; j++) {
      result[i] += A[i][j] * v[j];
    }
  }
  return result;
}

// Moltiplicazione matrice-matrice
function multiplyMatrices(A: number[][], B: number[][]): number[][] {
  const result = Array(A.length).fill(0).map(() => Array(B[0].length).fill(0));
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B[0].length; j++) {
      for (let k = 0; k < A[0].length; k++) {
        result[i][j] += A[i][k] * B[k][j];
      }
    }
  }
  return result;
}

// Trasposta di una matrice
function transposeMatrix(A: number[][]): number[][] {
  const result = Array(A[0].length).fill(0).map(() => Array(A.length).fill(0));
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < A[0].length; j++) {
      result[j][i] = A[i][j];
    }
  }
  return result;
}

// Somma di due matrici
function addMatrices(A: number[][], B: number[][]): number[][] {
  const result = Array(A.length).fill(0).map(() => Array(A[0].length).fill(0));
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < A[0].length; j++) {
      result[i][j] = A[i][j] + B[i][j];
    }
  }
  return result;
}

// Sottrazione di due matrici
function subtractMatrices(A: number[][], B: number[][]): number[][] {
  const result = Array(A.length).fill(0).map(() => Array(A[0].length).fill(0));
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < A[0].length; j++) {
      result[i][j] = A[i][j] - B[i][j];
    }
  }
  return result;
}

// Inversione di una matrice (implementazione semplificata per matrici 6x6)
function invertMatrix(A: number[][]): number[][] {
  // In una implementazione reale questo sarebbe più complesso
  // Qui usiamo una semplificazione assumendo che la matrice sia diagonale
  // quindi possiamo semplicemente invertire gli elementi sulla diagonale
  const result = Array(A.length).fill(0).map(() => Array(A[0].length).fill(0));
  for (let i = 0; i < A.length; i++) {
    result[i][i] = 1.0 / A[i][i];
  }
  return result;
}

// Implementazione del filtro di Madgwick per la fusione dei dati IMU
// Questo algoritmo è computazionalmente efficiente e offre buone prestazioni
// per la stima dell'orientamento.
const applyMadgwickFilter = (data: SensorDataPoint[], beta = 0.1): SensorDataPoint[] => {
  if (!data || data.length === 0) return [];
  
  const result = [...data];
  
  // Quaternione che rappresenta l'orientamento (inizializzato come identità)
  let q = [1, 0, 0, 0]; // [w, x, y, z]
  
  // Calcola il dt (intervallo di tempo) tra campioni consecutivi
  const calculateDt = (current: SensorDataPoint, previous: SensorDataPoint | null): number => {
    if (!previous) return 0.1; // Default a 100ms se non c'è un punto precedente
    
    // Utilizziamo il timestamp relativo per calcolare dt
    if (current.relativeTime !== undefined && previous.relativeTime !== undefined) {
      return current.relativeTime - previous.relativeTime;
    }
    
    // Fallback al timestamp del sistema
    return (current.timestamp - previous.timestamp) / 1000; // Converti in secondi
  };
  
  // Applica il filtro Madgwick a ogni punto
  for (let i = 0; i < result.length; i++) {
    const point = result[i];
    const prevPoint = i > 0 ? result[i-1] : null;
    const dt = calculateDt(point, prevPoint);
    
    // Limita dt a un valore massimo ragionevole per evitare salti eccessivi
    const limitedDt = Math.min(dt, 0.5);
    
    // Converte le velocità angolari da gradi/secondo a radianti/secondo
    const gx = degToRad(point.gyroX);
    const gy = degToRad(point.gyroY);
    const gz = degToRad(point.gyroZ);
    
    // Normalizza le letture dell'accelerometro
    const ax = point.accelX;
    const ay = point.accelY;
    const az = point.accelZ;
    const norm = Math.sqrt(ax * ax + ay * ay + az * az);
    const ax_norm = ax / norm;
    const ay_norm = ay / norm;
    const az_norm = az / norm;
    
    // Passo 1: Calcola il gradiente della funzione obiettivo
    // Struttura del quaternione: q = [q0, q1, q2, q3] = [w, x, y, z]
    const _2q0 = 2.0 * q[0];
    const _2q1 = 2.0 * q[1];
    const _2q2 = 2.0 * q[2];
    const _2q3 = 2.0 * q[3];
    const _4q0 = 4.0 * q[0];
    const _4q1 = 4.0 * q[1];
    const _4q2 = 4.0 * q[2];
    const _8q1 = 8.0 * q[1];
    const _8q2 = 8.0 * q[2];
    const q0q0 = q[0] * q[0];
    const q1q1 = q[1] * q[1];
    const q2q2 = q[2] * q[2];
    const q3q3 = q[3] * q[3];
    
    // Calcola il gradiente (Jacobiano della funzione obiettivo moltiplicato per l'errore)
    const s0 = _4q0 * q2q2 + _2q2 * ax_norm + _4q0 * q1q1 - _2q1 * ay_norm;
    const s1 = _4q1 * q3q3 - _2q3 * ax_norm + 4.0 * q0q0 * q[1] - _2q0 * ay_norm - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az_norm;
    const s2 = 4.0 * q0q0 * q[2] + _2q0 * ax_norm + _4q2 * q3q3 - _2q3 * ay_norm - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az_norm;
    const s3 = 4.0 * q1q1 * q[3] - _2q1 * ax_norm + 4.0 * q2q2 * q[3] - _2q2 * ay_norm;
    
    // Normalizza il gradiente
    const recipNorm = 1.0 / Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3);
    const s0_norm = s0 * recipNorm;
    const s1_norm = s1 * recipNorm;
    const s2_norm = s2 * recipNorm;
    const s3_norm = s3 * recipNorm;
    
    // Passo 2: Calcola la derivata del quaternione
    // Struttura: qdot = 0.5 * q ⊗ [0, gx, gy, gz] - beta * [s0, s1, s2, s3]
    const qDot0 = 0.5 * (-q[1] * gx - q[2] * gy - q[3] * gz) - beta * s0_norm;
    const qDot1 = 0.5 * (q[0] * gx + q[2] * gz - q[3] * gy) - beta * s1_norm;
    const qDot2 = 0.5 * (q[0] * gy - q[1] * gz + q[3] * gx) - beta * s2_norm;
    const qDot3 = 0.5 * (q[0] * gz + q[1] * gy - q[2] * gx) - beta * s3_norm;
    
    // Passo 3: Integra la derivata del quaternione per ottenere il nuovo quaternione
    q[0] += qDot0 * limitedDt;
    q[1] += qDot1 * limitedDt;
    q[2] += qDot2 * limitedDt;
    q[3] += qDot3 * limitedDt;
    
    // Normalizza il quaternione
    const recipNorm2 = 1.0 / Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    q[0] *= recipNorm2;
    q[1] *= recipNorm2;
    q[2] *= recipNorm2;
    q[3] *= recipNorm2;
    
    // Converti il quaternione in angoli di Eulero (roll, pitch, yaw)
    // Roll (x-axis rotation)
    const sinr_cosp = 2.0 * (q[0] * q[1] + q[2] * q[3]);
    const cosr_cosp = 1.0 - 2.0 * (q[1] * q[1] + q[2] * q[2]);
    const roll = Math.atan2(sinr_cosp, cosr_cosp) * (180.0 / Math.PI);
    
    // Pitch (y-axis rotation)
    const sinp = 2.0 * (q[0] * q[2] - q[3] * q[1]);
    let pitch;
    if (Math.abs(sinp) >= 1) {
      // Caso limite (gimbal lock)
      pitch = Math.sign(sinp) * 90.0;
    } else {
      pitch = Math.asin(sinp) * (180.0 / Math.PI);
    }
    
    // Yaw (z-axis rotation)
    const siny_cosp = 2.0 * (q[0] * q[3] + q[1] * q[2]);
    const cosy_cosp = 1.0 - 2.0 * (q[2] * q[2] + q[3] * q[3]);
    let yaw = Math.atan2(siny_cosp, cosy_cosp) * (180.0 / Math.PI);
    
    // Normalizza yaw nel range -180 a 180
    while (yaw > 180.0) yaw -= 360.0;
    while (yaw < -180.0) yaw += 360.0;
    
    // Aggiorna i risultati con gli angoli calcolati
    result[i].roll = roll;
    result[i].pitch = pitch;
    result[i].yaw = yaw;
  }
  
  return result;
};

// Funzione di utilità per convertire da gradi a radianti
const degToRad = (degrees: number): number => {
  return degrees * (Math.PI / 180);
};

// Funzione di utilità per convertire da radianti a gradi
const radToDeg = (radians: number): number => {
  return radians * (180 / Math.PI);
};



const TelemetryVisualization: React.FC = () => {
  const [data, setData] = useState<SensorDataPoint[]>([]);
  const [filteredData, setFilteredData] = useState<SensorDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<string>('acceleration');
  const [currentPoint, setCurrentPoint] = useState<SensorDataPoint | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [filterEnabled, setFilterEnabled] = useState<boolean>(true);
  const [filterType, setFilterType] = useState<FilterType>('complementary');
  const [isRealtime, setIsRealtime] = useState<boolean>(false);
  const [realtimeInterval, setRealtimeInterval] = useState<NodeJS.Timeout | null>(null);
  const [firstFetchTimestamp, setFirstFetchTimestamp] = useState<number>(0);
  // WebSocket connection state
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [wsError, setWsError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Funzione per connettersi al WebSocket
  const connectWebSocket = () => {
    // Determina l'URL del WebSocket
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = '192.168.4.1'; // Indirizzo dell'ESP8266
    const wsUrl = `${wsProtocol}//${wsHost}/ws`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    
    ws.onopen = () => {
      console.log('WebSocket connesso');
      setWsConnected(true);
      setWsError(null);
    };
    
    ws.onerror = (error) => {
      console.error('Errore WebSocket:', error);
      setWsError('Errore di connessione al WebSocket');
      setWsConnected(false);
    };
    
    ws.onclose = () => {
      console.log('WebSocket disconnesso');
      setWsConnected(false);
      
      // Riconnessione automatica dopo 3 secondi
      setTimeout(() => {
        if (isRealtime) {
          connectWebSocket();
        }
      }, 3000);
    };
    
    ws.onmessage = (event) => {
      try {
        const telemetryData = JSON.parse(event.data);
        
        // Crea un nuovo punto dati dal messaggio WebSocket
        const newDataPoint: SensorDataPoint = {
          timestamp: telemetryData.timestamp,
          relativeTime: (Date.now() - firstFetchTimestamp) / 1000,
          accelX: telemetryData.accel.x,
          accelY: telemetryData.accel.y,
          accelZ: telemetryData.accel.z,
          gyroX: telemetryData.gyro.x,
          gyroY: telemetryData.gyro.y,
          gyroZ: telemetryData.gyro.z,
          altitude: telemetryData.altitude,
          temperature: telemetryData.temperature,
          analogValue: 0 // Se non presente nel messaggio, usa un valore di default
        };
        
        // Aggiorna i dati
        setData(prevData => {
          const newData = [...prevData, newDataPoint];
          if (newData.length > 300) {
            return newData.slice(newData.length - 300);
          }
          return newData;
        });
        
        // Applica il filtro selezionato
        setFilteredData(prevFiltered => {
          const updatedData = [...prevFiltered, newDataPoint];
          const maxPoints = 300;
          let filtered;
          
          if (updatedData.length > maxPoints) {
            const slicedData = updatedData.slice(updatedData.length - maxPoints);
            filtered = applySelectedFilter(slicedData, filterType);
          } else {
            filtered = applySelectedFilter(updatedData, filterType);
          }
          
          return filtered;
        });
        
        // Aggiorna il punto corrente
        setCurrentPoint(filtered => {
          if (filtered && Array.isArray(filtered) && filtered.length > 0) {
            return filtered[filtered.length - 1];
          }
          return newDataPoint;
        });
      } catch (error) {
        console.error('Errore nell\'elaborazione del messaggio WebSocket:', error);
      }
    };
  };

  // Effetto per gestire la pulizia
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  // Funzione per applicare il filtro selezionato ai dati
  const applySelectedFilter = (data: SensorDataPoint[], filterType: FilterType): SensorDataPoint[] => {
    switch (filterType) {
      case 'complementary':
        return applyImprovedComplementaryFilter(data);
      case 'kalman':
        return applyKalmanFilter(data);
      case 'madgwick':
        return applyMadgwickFilter(data);
      default:
        return applyImprovedComplementaryFilter(data);
    }
  };

  // Effetto per riapplicare il filtro quando cambia il tipo di filtro
  useEffect(() => {
    if (data.length === 0) return;
    const filteredResult = applySelectedFilter(data, filterType);
    setFilteredData(filteredResult);
    
    // Aggiorna il punto corrente se esiste
    if (currentPoint) {
      const index = data.findIndex(p => p.timestamp === currentPoint.timestamp);
      if (index !== -1 && filteredResult[index]) {
        setCurrentPoint(filteredResult[index]);
      }
    }
  }, [filterType]);

  // Dimensioni del razzo per la visualizzazione 3D
  const rocketLength = 80;
  const rocketWidth = 20;

  // Funzione per simulare dei dati
  const mockRocketApi = (): Promise<ApiResponse> => {
    // Simula il ritardo di rete
    return new Promise((resolve) => {
      setTimeout(() => {
        // Genera dati fake che simulano il movimento del razzo
        const time = Date.now();
        const oscillation = Math.sin(time / 1000);
        const fastOscillation = Math.sin(time / 200);
        
        resolve({
          sensors: {
            accel: {
              x: oscillation * 0.5,
              y: Math.cos(time / 1500) * 0.3,
              z: -1 + fastOscillation * 0.1
            },
            gyro: {
              x: Math.cos(time / 800) * 15,
              y: oscillation * 10,
              z: fastOscillation * 25
            },
            // Aggiungi l'altitudine simulata (oscillante)
            altitude: 100 + Math.sin(time / 3000) * 20
          },
          system: {
            millis: time
          }
        });
      }, 100); // Simula 100ms di latenza
    });
  };

  // Versione migliorata della funzione fetchRealtimeData
  // Modifica la funzione fetchRealtimeData per gestire correttamente i timestamp relativi
  // Versione migliorata della funzione fetchRealtimeData per utilizzare il filtro selezionato
  const fetchRealtimeData = async (): Promise<void> => {
    let retries = 3; // Numero di tentativi in caso di errore
    
    const attemptFetch = async (): Promise<void> => {
      try {
        const jsonData = await mockRocketApi(); // Usa dati mockati
        /*
        const response = await fetch('http://192.168.4.1/imudata', {
          signal: AbortSignal.timeout(2000)
        });
        
        if (!response.ok) {
          throw new Error(`Errore nella richiesta: ${response.status}`);
        }
        
        const jsonData = await response.json();
        */
        
        // Timestamp attuale in millisecondi
        const currentTimestamp = Date.now();
        
        // Se è il primo punto, imposta il timestamp di riferimento
        if (data.length === 0) {
          setFirstFetchTimestamp(currentTimestamp);
        }
        
        // Calcolo del timestamp relativo rispetto al primo punto
        const relativeTime = (currentTimestamp - firstFetchTimestamp) / 1000; // in secondi
        
        // Crea un nuovo punto dati con un timestamp relativo
        const newDataPoint: SensorDataPoint = {
          timestamp: jsonData.system.millis,
          relativeTime: relativeTime,
          accelX: jsonData.sensors.accel.x,
          accelY: jsonData.sensors.accel.y,
          accelZ: jsonData.sensors.accel.z,
          gyroX: jsonData.sensors.gyro.x,
          gyroY: jsonData.sensors.gyro.y,
          gyroZ: jsonData.sensors.gyro.z,
          altitude: jsonData.sensors.altitude !== undefined ? jsonData.sensors.altitude : 0
        };
        
        // Aggiungiamo il nuovo punto ai dati esistenti
        setData(prevData => {
          const newData = [...prevData, newDataPoint];
          // Se ci sono troppi punti, rimuoviamo quelli più vecchi
          if (newData.length > 300) { // Limitato a 300 punti per prestazioni migliori
            return newData.slice(newData.length - 300);
          }
          return newData;
        });
        
        // Applichiamo il filtro selezionato
        setFilteredData(prevFiltered => {
          const updatedData = [...prevFiltered, newDataPoint];
          const maxPoints = 300;
          let filtered;
          
          if (updatedData.length > maxPoints) {
            const slicedData = updatedData.slice(updatedData.length - maxPoints);
            filtered = applySelectedFilter(slicedData, filterType);
          } else {
            filtered = applySelectedFilter(updatedData, filterType);
          }
          
          return filtered;
        });
        
        // Aggiorniamo il punto corrente
        setCurrentPoint(filtered => {
          if (filtered && Array.isArray(filtered) && filtered.length > 0) {
            return filtered[filtered.length - 1];
          }
          return newDataPoint;
        });
        
      } catch (error) {
        console.error('Errore nel recupero dei dati in tempo reale:', error);
        
        retries--;
        if (retries > 0) {
          console.log(`Tentativo di riconnessione... (${retries} rimasti)`);
          return await attemptFetch(); // Riprova
        } else {
          // Dopo 3 tentativi falliti, disattiviamo la modalità real-time
          console.error('Connessione persa dopo multipli tentativi.');
          stopRealtimeData();
        }
      }
    };
    
    await attemptFetch();
  };

  // Funzione per avviare il recupero dei dati in tempo reale
  const startRealtimeData = (): void => {
    if (isRealtime) return; // Se è già attivo, non facciamo nulla
    
    setFirstFetchTimestamp(Date.now());
    setData([]);
    setFilteredData([]);
    
    // Connetti al WebSocket
    connectWebSocket();
    
    setIsRealtime(true);
  };

  // Funzione per fermare il recupero dei dati in tempo reale
  const stopRealtimeData = (): void => {
    if (realtimeInterval) {
      clearInterval(realtimeInterval);
      setRealtimeInterval(null);
    }
    
    // Chiudi la connessione WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    setIsRealtime(false);
  };

  // Pulizia dell'intervallo quando il componente viene smontato
  useEffect(() => {
    return () => {
      if (realtimeInterval) {
        clearInterval(realtimeInterval);
      }
    };
  }, [realtimeInterval]);
  
  // Funzione per caricare un file selezionato dall'utente
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    try {
      setIsLoading(true);
      const fileContent = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          if (e.target && typeof e.target.result === 'string') {
            resolve(e.target.result);
          }
        };
        reader.readAsText(file);
      });
      
      processData(fileContent);
    } catch (error) {
      console.error('Errore nel caricamento del file:', error);
      setIsLoading(false);
    }
  };
  
  // Funzione per caricare il file predefinito
  const loadDefaultFile = async (): Promise<void> => {
    try {
      setIsLoading(true);
      // Utilizziamo fetch invece di window.fs.readFile
      const response = await fetch('/paste.txt');
      if (!response.ok) {
        throw new Error(`Errore nel caricamento del file: ${response.status}`);
      }
      const fileContent = await response.text();
      processData(fileContent);
    } catch (error) {
      console.error('Errore nel caricamento del file predefinito:', error);
      setIsLoading(false);
    }
  };

    // Funzione per caricare il file predefinito
    const loadGoldenSlumbers1 = async (): Promise<void> => {
      try {
        setIsLoading(true);
        // Utilizziamo fetch invece di window.fs.readFile
        const response = await fetch('/GoldenSlumbers1.txt');
        if (!response.ok) {
          throw new Error(`Errore nel caricamento del file: ${response.status}`);
        }
        const fileContent = await response.text();
        processData(fileContent);
      } catch (error) {
        console.error('Errore nel caricamento del file predefinito:', error);
        setIsLoading(false);
      }
    };
  
  // Funzione per processare i dati CSV
  const processData = (fileContent: string): void => {
    // Parsing del CSV
    const rows = fileContent.split('\n').filter(row => row.trim().length > 0);
    const headers = rows[0].split('\t').map(h => h.trim());
    
    const parsedData: SensorDataPoint[] = rows.slice(1).map(row => {
      const values = row.split('\t');
      const rowData: Record<string, number> = {};
      
      headers.forEach((header, index) => {
        if (index === 0) {
          rowData[header] = parseInt(values[index]);
        } else {
          rowData[header] = parseFloat(values[index].replace(',', '.'));
        }
      });
      
      return rowData as unknown as SensorDataPoint;
    });
    
    // Calcolo del timestamp relativo
    const startTime = parsedData[0].timestamp;
    parsedData.forEach(row => {
      row.relativeTime = (row.timestamp - startTime) / 1000; // in secondi
    });
    
    // CORREZIONE 1: Verifica dell'orientamento dell'accelerometro
    // Verifichiamo se l'accelerometro ha Z invertito (tipico in alcuni sensori IMU)
    // Utilizziamo le prime 20 misurazioni (o meno se non disponibili)
    const samplesToCheck = Math.min(20, parsedData.length);
    let avgAccelZ = 0;
    
    for (let i = 0; i < samplesToCheck; i++) {
      avgAccelZ += parsedData[i].accelZ;
    }
    avgAccelZ /= samplesToCheck;
    
    // Se l'asse Z medio è positivo, molto probabilmente è invertito
    // (in condizioni normali a riposo, Z dovrebbe essere circa -1g)
    const needsZInversion = avgAccelZ > 0;
    
    if (needsZInversion) {
      console.log("Rilevato accelerometro con asse Z invertito, normalizzazione in corso...");
      // Invertiamo l'asse Z per tutti i punti
      parsedData.forEach(point => {
        point.accelZ = -point.accelZ;
      });
    }
    
    setData(parsedData);
    
    // Applicazione del filtro selezionato
    const filteredResult = applySelectedFilter(parsedData, filterType);
    setFilteredData(filteredResult);
    
    // Imposta il punto corrente al primo punto dei dati
    if (filteredResult.length > 0) {
      setCurrentPoint(filteredResult[0]);
    }
    
    setIsLoading(false);
  };
  
  // Carica il file predefinito all'avvio
  useEffect(() => {
    loadDefaultFile();
  }, []);
  
  // This is the updated code for the 3D visualization function in useEffect
  useEffect(() => {
    if (!currentPoint || !canvasRef.current) return;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const width = canvas.width;
    const height = canvas.height;
    
    // Pulisci il canvas
    ctx.clearRect(0, 0, width, height);
    
    // Centro del canvas
    const centerX = width / 2;
    const centerY = height / 2;
    
    // Ottieni gli angoli in radianti
    const rollRad = filterEnabled  && currentPoint.roll !== undefined ? degToRad(currentPoint.roll) : 0;
    const pitchRad = filterEnabled  && currentPoint.pitch !== undefined ? degToRad(currentPoint.pitch) : 0;
    const yawRad = filterEnabled  && currentPoint.yaw !== undefined ? degToRad(currentPoint.yaw) : 0;
    
    // Definizione di accelScale per i vettori di accelerazione
    const accelScale = 50;
    
    // Disegna gli assi di riferimento
    drawReferenceAxes(ctx, width, height);
    
    // Dividi il canvas in due parti: vista laterale e vista dall'alto
    const mainViewSize = Math.min(width, height) * 0.6;
    const topViewSize = Math.min(width, height) * 0.25;
    
    // Modifica la parte che si occupa della vista laterale del razzo
    // Vista principale (laterale, mostra principalmente pitch e roll)
    ctx.save();
    ctx.translate(centerX, centerY);

    // CORREZIONE: L'orientamento iniziale deve essere con la punta verso l'alto
    // Questo significa che il pitch di base deve essere 0 (non Math.PI)
    // Applica prima il roll, poi il pitch (inizialmente 0 + pitch misurato)
    ctx.rotate(rollRad);
    ctx.rotate(pitchRad);

    // Disegna il razzo nella vista laterale
    drawRocketSideView(ctx, rocketWidth, rocketLength);

    ctx.restore();
    
    // Vista dall'alto (mostra principalmente yaw e roll)
    ctx.save();
    ctx.translate(width - topViewSize/2 - 20, topViewSize/2 + 20);
    
    // Disegna lo sfondo della vista dall'alto
    ctx.fillStyle = '#f0f0f0';
    ctx.beginPath();
    ctx.arc(0, 0, topViewSize/2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Applica rotazione yaw
    ctx.rotate(yawRad);
    
    // Disegna il razzo dall'alto
    drawRocketTopView(ctx, rocketWidth, rocketLength, rollRad);
    
    ctx.restore();
    
    // Vista frontale (mostra principalmente roll e parte di yaw)
    ctx.save();
    ctx.translate(topViewSize/2 + 20, topViewSize/2 + 20);
    
    // Disegna lo sfondo della vista frontale
    ctx.fillStyle = '#f0f0e0';
    ctx.beginPath();
    ctx.arc(0, 0, topViewSize/2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Applica rotazioni per la vista frontale
    ctx.rotate(rollRad); // Il roll è la rotazione principale visibile frontalmente
    
    // Disegna il razzo dalla parte frontale
    drawRocketFrontView(ctx, rocketWidth, pitchRad);
    
    ctx.restore();
    
    // Disegna le etichette per le viste
    ctx.font = '12px Arial';
    ctx.fillStyle = '#000';
    ctx.fillText('Vista Laterale', centerX - 40, centerY + mainViewSize/2 + 15);
    ctx.fillText('Vista dall\'Alto', width - topViewSize - 15, 15);
    ctx.fillText('Vista Frontale', 20, 15);
    
    // Disegna i vettori di accelerazione sulla vista principale
    drawAccelerationVectors(ctx, centerX, centerY, currentPoint, accelScale);
    
    // Disegna la legenda
    drawLegend(ctx, width, height);
    
  }, [currentPoint, filterEnabled, rocketWidth, rocketLength]);
  
  // Funzione per disegnare gli assi di riferimento
  function drawReferenceAxes(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const axisLength = 40;
    ctx.lineWidth = 1;
    
    // Asse X (rosso)
    ctx.strokeStyle = '#ff0000';
    ctx.beginPath();
    ctx.moveTo(10, height - 10);
    ctx.lineTo(10 + axisLength, height - 10);
    ctx.stroke();
    ctx.fillStyle = '#ff0000';
    ctx.fillText('X', 10 + axisLength + 5, height - 7);
    
    // Asse Y (verde)
    ctx.strokeStyle = '#00ff00';
    ctx.beginPath();
    ctx.moveTo(10, height - 10);
    ctx.lineTo(10, height - 10 - axisLength);
    ctx.stroke();
    ctx.fillStyle = '#00ff00';
    ctx.fillText('Y', 10, height - 10 - axisLength - 5);
    
    // Asse Z (blu)
    ctx.strokeStyle = '#0000ff';
    ctx.beginPath();
    ctx.moveTo(10, height - 10);
    ctx.lineTo(10 + axisLength * 0.7, height - 10 - axisLength * 0.7);
    ctx.stroke();
    ctx.fillStyle = '#0000ff';
    ctx.fillText('Z', 10 + axisLength * 0.7 + 5, height - 10 - axisLength * 0.7 - 5);
  }
  
  // Funzione per disegnare il razzo nella vista laterale
  function drawRocketSideView(ctx: CanvasRenderingContext2D, rocketWidth: number, rocketLength: number) {
    // Disegna il corpo del razzo
    ctx.fillStyle = '#d0d0d0';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    
    // Il corpo del razzo è centrato sull'origine
    ctx.beginPath();
    ctx.rect(-rocketWidth / 2, -rocketLength / 2, rocketWidth, rocketLength);
    ctx.fill();
    ctx.stroke();
    
    // CORREZIONE: La punta del razzo deve essere disegnata nella parte inferiore
    // (visivamente verso il basso nel canvas, ma rappresenta "l'alto" del razzo)
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.moveTo(-rocketWidth / 2, rocketLength / 2);  // Punto in basso a sinistra
    ctx.lineTo(0, rocketLength / 2 + 20);           // Punta in basso
    ctx.lineTo(rocketWidth / 2, rocketLength / 2);   // Punto in basso a destra
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Le alette alla base del razzo (in alto nel disegno)
    // Aletta 1 (sinistra)
    ctx.fillStyle = '#4444ff';
    ctx.beginPath();
    ctx.moveTo(-rocketWidth / 2, -rocketLength / 2);
    ctx.lineTo(-rocketWidth / 2 - 15, -rocketLength / 2 - 20);
    ctx.lineTo(-rocketWidth / 2, -rocketLength / 2 + 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Aletta 2 (destra)
    ctx.fillStyle = '#4444ff';
    ctx.beginPath();
    ctx.moveTo(rocketWidth / 2, -rocketLength / 2);
    ctx.lineTo(rocketWidth / 2 + 15, -rocketLength / 2 - 20);
    ctx.lineTo(rocketWidth / 2, -rocketLength / 2 + 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Aletta 3 (posteriore - in diverso colore per distinguere meglio la rotazione yaw)
    ctx.fillStyle = '#44ff44';
    ctx.beginPath();
    ctx.moveTo(0, -rocketLength / 2);
    ctx.lineTo(0, -rocketLength / 2 - 20);
    ctx.lineTo(10, -rocketLength / 2 + 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Aletta 4 (anteriore - in diverso colore per distinguere meglio la rotazione yaw)
    ctx.fillStyle = '#ff44ff';
    ctx.beginPath();
    ctx.moveTo(0, -rocketLength / 2);
    ctx.lineTo(0, -rocketLength / 2 - 20);
    ctx.lineTo(-10, -rocketLength / 2 + 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  
  // Funzione per disegnare il razzo nella vista dall'alto
  function drawRocketTopView(ctx: CanvasRenderingContext2D, rocketWidth: number, rocketLength: number, rollRad: number) {
    // Nell'ottica dall'alto, vediamo il razzo schiacciato
    const topWidth = rocketWidth;
    const topLength = rocketLength * 0.75;
    
    // Applica roll per vedere la rotazione anche nella vista dall'alto
    ctx.save();
    ctx.rotate(rollRad / 3);
    
    // Disegna il corpo del razzo dall'alto
    ctx.fillStyle = '#e0e0e0';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    
    // Usiamo un'ellisse per rappresentare il razzo visto dall'alto
    ctx.beginPath();
    ctx.ellipse(0, 0, topWidth / 2, topLength / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    // CORREZIONE: La punta del razzo deve puntare verso il sud
    // Freccia di direzione (punta del razzo)
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.moveTo(0, topLength / 2 + 10);  // Punta a sud
    ctx.lineTo(-8, topLength / 2);
    ctx.lineTo(8, topLength / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
      
    // Indicatore per le alette viste dall'alto
    const finOffset = topLength / 3;
    
    // Alette laterali (blu)
    ctx.fillStyle = '#4444ff';
    ctx.beginPath();
    ctx.ellipse(-topWidth / 2 - 5, -finOffset, 5, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    ctx.beginPath();
    ctx.ellipse(topWidth / 2 + 5, -finOffset, 5, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    // Alette avant/retro (verde/magenta)
    ctx.fillStyle = '#44ff44';
    ctx.beginPath();
    ctx.ellipse(0, -topLength / 2 - 5, 10, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    ctx.fillStyle = '#ff44ff';
    ctx.beginPath();
    ctx.ellipse(0, finOffset, 10, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    ctx.restore();
    
    // Disegna punti cardinali per il riferimento di yaw
    ctx.fillStyle = '#000';
    ctx.font = '10px Arial';
    ctx.fillText('N', 0, -topLength / 2 - 15);
    ctx.fillText('S', 0, topLength / 2 + 15);
    ctx.fillText('E', topLength / 2 + 15, 0);
    ctx.fillText('W', -topLength / 2 - 15, 0);
  }
  
  // Funzione per disegnare il razzo nella vista frontale
  function drawRocketFrontView(ctx: CanvasRenderingContext2D, rocketWidth: number, pitchRad: number) {
    // Nella vista frontale, vediamo solo la sezione circolare del razzo
    const radius = rocketWidth / 2;
    
    // Applica pitch per vedere l'effetto anche nella vista frontale
    ctx.save();
    // CORREZIONE 2: Assicuriamoci che pitchEffect sia sempre positivo
    // Se il pitch è positivo, il razzo punta leggermente verso l'osservatore
    // Se il pitch è negativo, il razzo punta leggermente lontano dall'osservatore
    // Questo si traduce in una leggera ellissi
    // Utilizziamo Math.abs() per garantire che il raggio sia sempre positivo
    // ed evitiamo l'errore "Failed to execute 'ellipse': radius provided is negative"
    const pitchEffect = Math.abs(Math.cos(pitchRad));
    
    // Disegna il corpo del razzo visto frontalmente
    ctx.fillStyle = '#e0e0e0';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, radius, radius * pitchEffect, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    // Disegna le alette come viste frontalmente
    // Aletta superiore (magenta)
    ctx.fillStyle = '#ff44ff';
    ctx.beginPath();
    ctx.moveTo(0, -radius);
    ctx.lineTo(-radius/2, -radius*1.5);
    ctx.lineTo(radius/2, -radius*1.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Aletta inferiore (verde)
    ctx.fillStyle = '#44ff44';
    ctx.beginPath();
    ctx.moveTo(0, radius);
    ctx.lineTo(-radius/2, radius*1.5);
    ctx.lineTo(radius/2, radius*1.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Alette laterali (blu)
    ctx.fillStyle = '#4444ff';
    ctx.beginPath();
    ctx.moveTo(-radius, 0);
    ctx.lineTo(-radius*1.5, -radius/2);
    ctx.lineTo(-radius*1.5, radius/2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(radius, 0);
    ctx.lineTo(radius*1.5, -radius/2);
    ctx.lineTo(radius*1.5, radius/2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Linea indicatrice verticale per orientamento
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -radius*1.8);
    ctx.lineTo(0, radius*1.8);
    ctx.stroke();
    
    // Linea indicatrice orizzontale per orientamento
    ctx.beginPath();
    ctx.moveTo(-radius*1.8, 0);
    ctx.lineTo(radius*1.8, 0);
    ctx.stroke();
    
    ctx.restore();
  }
  
  
  // Funzione per disegnare i vettori di accelerazione
  function drawAccelerationVectors(
    ctx: CanvasRenderingContext2D, 
    centerX: number, 
    centerY: number, 
    currentPoint: SensorDataPoint, 
    accelScale: number
  ) {
    ctx.save();
    ctx.translate(centerX, centerY);
    
    // Vettore X (rosso)
    const accelX = currentPoint.accelX * accelScale;
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -accelX);
    ctx.stroke();
    
    // Freccia X
    if (Math.abs(accelX) > 5) {
      const arrowSize = 5;
      ctx.beginPath();
      if (accelX > 0) {
        ctx.moveTo(0, -accelX);
        ctx.lineTo(-arrowSize, -accelX + arrowSize);
        ctx.lineTo(arrowSize, -accelX + arrowSize);
      } else {
        ctx.moveTo(0, -accelX);
        ctx.lineTo(-arrowSize, -accelX - arrowSize);
        ctx.lineTo(arrowSize, -accelX - arrowSize);
      }
      ctx.closePath();
      ctx.fillStyle = '#ff0000';
      ctx.fill();
    }
    
    // Vettore Y (verde)
    const accelY = currentPoint.accelY * accelScale;
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(accelY, 0);
    ctx.stroke();
    
    // Freccia Y
    if (Math.abs(accelY) > 5) {
      const arrowSize = 5;
      ctx.beginPath();
      if (accelY > 0) {
        ctx.moveTo(accelY, 0);
        ctx.lineTo(accelY - arrowSize, -arrowSize);
        ctx.lineTo(accelY - arrowSize, arrowSize);
      } else {
        ctx.moveTo(accelY, 0);
        ctx.lineTo(accelY + arrowSize, -arrowSize);
        ctx.lineTo(accelY + arrowSize, arrowSize);
      }
      ctx.closePath();
      ctx.fillStyle = '#00ff00';
      ctx.fill();
    }
    
    // Vettore Z (blu)
    const accelZ = currentPoint.accelZ * accelScale;
    ctx.strokeStyle = '#0000ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, accelZ);
    ctx.stroke();
    
    // Freccia Z
    if (Math.abs(accelZ) > 5) {
      const arrowSize = 5;
      ctx.beginPath();
      if (accelZ > 0) {
        ctx.moveTo(0, accelZ);
        ctx.lineTo(-arrowSize, accelZ - arrowSize);
        ctx.lineTo(arrowSize, accelZ - arrowSize);
      } else {
        ctx.moveTo(0, accelZ);
        ctx.lineTo(-arrowSize, accelZ + arrowSize);
        ctx.lineTo(arrowSize, accelZ + arrowSize);
      }
      ctx.closePath();
      ctx.fillStyle = '#0000ff';
      ctx.fill();
    }
    
    // Vettore di accelerazione totale (viola)
    const totalAccel = Math.sqrt(accelX*accelX + accelY*accelY + accelZ*accelZ);
    if (totalAccel > 5) {
      ctx.strokeStyle = '#800080';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(accelY, -accelX + accelZ);
      ctx.stroke();
      
      // Freccia per l'accelerazione totale
      const arrowSize = 6;
      const angle = Math.atan2(-accelX + accelZ, accelY);
      ctx.beginPath();
      ctx.moveTo(accelY, -accelX + accelZ);
      ctx.lineTo(
        accelY - arrowSize * Math.cos(angle - Math.PI/6), 
        (-accelX + accelZ) - arrowSize * Math.sin(angle - Math.PI/6)
      );
      ctx.lineTo(
        accelY - arrowSize * Math.cos(angle + Math.PI/6), 
        (-accelX + accelZ) - arrowSize * Math.sin(angle + Math.PI/6)
      );
      ctx.closePath();
      ctx.fillStyle = '#800080';
      ctx.fill();
    }
    
    ctx.restore();
  }
  
  // Funzione per disegnare la legenda
  function drawLegend(ctx: CanvasRenderingContext2D, width: number, height: number) {
    ctx.font = '14px Arial';
    ctx.fillStyle = '#000';
    ctx.fillText('Orientamento del Razzo', width - 170, 20);
    
    const legendY = 40;
    const legendSpacing = 20;
    
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(width - 170, legendY, 15, 15);
    ctx.fillStyle = '#000';
    ctx.fillText('Accel X', width - 150, legendY + 12);
    
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(width - 170, legendY + legendSpacing, 15, 15);
    ctx.fillStyle = '#000';
    ctx.fillText('Accel Y', width - 150, legendY + legendSpacing + 12);
    
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(width - 170, legendY + legendSpacing * 2, 15, 15);
    ctx.fillStyle = '#000';
    ctx.fillText('Accel Z', width - 150, legendY + legendSpacing * 2 + 12);
    
    ctx.fillStyle = '#800080';
    ctx.fillRect(width - 170, legendY + legendSpacing * 3, 15, 15);
    ctx.fillStyle = '#000';
    ctx.fillText('Accel Totale', width - 150, legendY + legendSpacing * 3 + 12);
  }

  
  // Gestione del movimento del mouse sul grafico
  const handleMouseMove = (e: any): void => {
    if (!e.activePayload || e.activePayload.length === 0) return;
    
    const payload = e.activePayload[0].payload;
    setCurrentPoint(payload);
  };
  
  // Formattazione personalizzata per i tooltip
  const renderTooltip = (props: any): React.ReactNode => {
    if (!props.active || !props.payload || props.payload.length === 0) {
      return null;
    }
    
    const { payload } = props;
    const data = payload[0].payload;
    
    return (
      <div className="bg-white p-2 border border-gray-300 rounded shadow-sm">
        <p className="font-semibold">{`Tempo: ${data.relativeTime.toFixed(2)}s`}</p>
        {activeTab === 'acceleration' && (
          <>
            <p>{`AccelX: ${data.accelX.toFixed(4)}`}</p>
            <p>{`AccelY: ${data.accelY.toFixed(4)}`}</p>
            <p>{`AccelZ: ${data.accelZ.toFixed(4)}`}</p>
          </>
        )}
        {activeTab === 'gyroscope' && (
          <>
            <p>{`GyroX: ${data.gyroX.toFixed(4)}`}</p>
            <p>{`GyroY: ${data.gyroY.toFixed(4)}`}</p>
            <p>{`GyroZ: ${data.gyroZ.toFixed(4)}`}</p>
          </>
        )}
        {activeTab === 'orientation' && (
          <>
            <p>{`Roll: ${data.roll?.toFixed(2) || 'N/A'}°`}</p>
            <p>{`Pitch: ${data.pitch?.toFixed(2) || 'N/A'}°`}</p>
            <p>{`Yaw: ${data.yaw?.toFixed(2) || 'N/A'}°`}</p>
          </>
        )}
        {activeTab === 'altitude' && (
          <p>{`Altitude: ${data.altitude.toFixed(2)}m`}</p>
        )}
      </div>
    );
  };
  
  if (isLoading) {
    return <div className="flex items-center justify-center h-64">Caricamento dati...</div>;
  }
  
  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4 text-center">Visualizzazione Avanzata Telemetria Razzo</h2>
      
      {/* Controlli per la selezione del file e opzioni */}
      <div className="flex flex-wrap items-center gap-4 mb-6 p-4 bg-gray-100 rounded">
        <div>
          <label htmlFor="fileInput" className="mr-2">Seleziona File CSV:</label>
          <input
            type="file"
            id="fileInput"
            accept=".csv,.txt"
            onChange={handleFileSelect}
            className="border p-1 rounded"
            disabled={isRealtime}
          />
        </div>
        
        <button 
          onClick={loadDefaultFile}
          className="px-4 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
          disabled={isRealtime}
        >
          Carica File Predefinito
        </button>

        <button 
          onClick={loadGoldenSlumbers1}
          className="px-4 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
          disabled={isRealtime}
        >
          Golden Slumbers 1
        </button>
        
        {/* Controlli per il filtro */}
        <div className="flex items-center mx-2">
          <label htmlFor="filterToggle" className="mr-2">Filtro:</label>
          <input
            type="checkbox"
            id="filterToggle"
            checked={filterEnabled}
            onChange={(e) => setFilterEnabled(e.target.checked)}
            className="w-4 h-4"
          />
        </div>

        {/* Tipo di filtro */}
        <div className="flex items-center">
          <label htmlFor="filterType" className="mr-2">Tipo di Filtro:</label>
          <select
            id="filterType"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as FilterType)}
            className="border p-1 rounded"
            disabled={!filterEnabled}
          >
            <option value="complementary">Complementare</option>
            <option value="kalman">Kalman</option>
            <option value="madgwick">Madgwick</option>
          </select>
        </div>
        
        {/* Aggiungi i pulsanti per il controllo real-time */}
        <div className="ml-auto flex gap-2">
          <button 
            onClick={startRealtimeData}
            disabled={isRealtime}
            className={`px-4 py-1 rounded ${isRealtime ? 'bg-gray-400' : 'bg-green-500 text-white hover:bg-green-600'}`}
          >
            REALTIME ON
          </button>
          <button 
            onClick={stopRealtimeData}
            disabled={!isRealtime}
            className={`px-4 py-1 rounded ${!isRealtime ? 'bg-gray-400' : 'bg-red-500 text-white hover:bg-red-600'}`}
          >
            REALTIME OFF
          </button>
        </div>
      </div>

      {/* indicatore di stato real-time */}
      {isRealtime && (
        <div className="mb-4 p-2 bg-green-100 border border-green-300 rounded text-center">
          <p className="font-semibold flex items-center justify-center">
            <span className="inline-block w-3 h-3 bg-green-500 rounded-full mr-2 animate-pulse"></span>
            Modalità Real-time Attiva - Connesso a 192.168.4.1
          </p>
        </div>
      )}
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Grafico */}
        <div className="border rounded p-4">
          {/* Tabs per selezionare il grafico */}
          <div className="flex border-b mb-4 overflow-x-auto">
            <button 
              className={`px-4 py-2 whitespace-nowrap ${activeTab === 'acceleration' ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}
              onClick={() => setActiveTab('acceleration')}
            >
              Accelerometro
            </button>
            <button 
              className={`px-4 py-2 whitespace-nowrap ${activeTab === 'gyroscope' ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}
              onClick={() => setActiveTab('gyroscope')}
            >
              Giroscopio
            </button>
            <button 
              className={`px-4 py-2 whitespace-nowrap ${activeTab === 'orientation' ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}
              onClick={() => setActiveTab('orientation')}
            >
              Orientamento
            </button>
            <button 
              className={`px-4 py-2 whitespace-nowrap ${activeTab === 'altitude' ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}
              onClick={() => setActiveTab('altitude')}
            >
              Altitudine
            </button>
          </div>
          
          {/* Grafico di accelerazione */}
          {activeTab === 'acceleration' && (
            <div>
              <h3 className="text-lg font-semibold mb-2">Dati Accelerometro</h3>
              <ResponsiveContainer width="100%" height={400}>
                <LineChart 
                  data={filteredData} 
                  margin={{ top: 10, right: 30, left: 10, bottom: 10 }}
                  onMouseMove={handleMouseMove}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="relativeTime" 
                    type="number"
                    domain={[(dataMax: number) => (dataMax > 30 ? dataMax - 30 : 0), 'dataMax']}
                    label={{ value: 'Tempo (s)', position: 'insideBottom', offset: -5 }}
                  />
                  <YAxis 
                    domain={[-2.5, 2.5]} 
                    label={{ value: 'Accelerazione (g)', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip content={renderTooltip} />
                  <Legend />
                  
                  <Line 
                    type="monotone" 
                    dataKey="accelX" 
                    stroke="#f44336" 
                    name="AccelX" 
                    dot={false} 
                    strokeWidth={2}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="accelY" 
                    stroke="#4caf50" 
                    name="AccelY" 
                    dot={false} 
                    strokeWidth={2}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="accelZ" 
                    stroke="#2196f3" 
                    name="AccelZ" 
                    dot={false} 
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          
          {/* Grafico del giroscopio */}
          {activeTab === 'gyroscope' && (
            <div>
              <h3 className="text-lg font-semibold mb-2">Dati Giroscopio</h3>
              <ResponsiveContainer width="100%" height={400}>
                <LineChart 
                  data={filteredData} 
                  margin={{ top: 10, right: 30, left: 10, bottom: 10 }}
                  onMouseMove={handleMouseMove}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="relativeTime" 
                    type="number"
                    domain={[(dataMax: number) => (dataMax > 30 ? dataMax - 30 : 0), 'dataMax']}
                    label={{ value: 'Tempo (s)', position: 'insideBottom', offset: -5 }}
                  />
                  <YAxis 
                    domain={[-70, 70]} 
                    label={{ value: 'Velocità angolare (°/s)', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip content={renderTooltip} />
                  <Legend />
                  
                  <Line 
                    type="monotone" 
                    dataKey="gyroX" 
                    stroke="#9c27b0" 
                    name="GyroX" 
                    dot={false} 
                    strokeWidth={2}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="gyroY" 
                    name="GyroY" 
                    stroke="#ff9800" 
                    dot={false} 
                    strokeWidth={2}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="gyroZ" 
                    name="GyroZ" 
                    stroke="#03a9f4" 
                    dot={false} 
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          
          {/* Grafico dell'orientamento filtrato */}
          {activeTab === 'orientation' && (
            <div>
              <h3 className="text-lg font-semibold mb-2">Orientamento (Filtro: {filterType === 'complementary' ? 'Complementare' : filterType === 'kalman' ? 'Kalman' : 'Madgwick'})</h3>
              <ResponsiveContainer width="100%" height={400}>
                <LineChart 
                  data={filteredData} 
                  margin={{ top: 10, right: 30, left: 10, bottom: 10 }}
                  onMouseMove={handleMouseMove}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="relativeTime" 
                    type="number"
                    domain={[(dataMax: number) => (dataMax > 30 ? dataMax - 30 : 0), 'dataMax']}
                    label={{ value: 'Tempo (s)', position: 'insideBottom', offset: -5 }}
                  />
                  <YAxis 
                    domain={[-180, 180]} 
                    label={{ value: 'Angoli (°)', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip content={renderTooltip} />
                  <Legend />
                  
                  <Line 
                    type="monotone" 
                    dataKey="roll" 
                    stroke="#673ab7" 
                    name="Roll" 
                    dot={false} 
                    strokeWidth={2}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="pitch" 
                    stroke="#ff5722" 
                    name="Pitch" 
                    dot={false} 
                    strokeWidth={2}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="yaw" 
                    stroke="#009688" 
                    name="Yaw" 
                    dot={false} 
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          
          {/* Grafico dell'altitudine */}
          {activeTab === 'altitude' && (
            <div>
              <h3 className="text-lg font-semibold mb-2">Dati Altitudine</h3>
              <ResponsiveContainer width="100%" height={400}>
                <LineChart 
                  data={filteredData} 
                  margin={{ top: 10, right: 30, left: 10, bottom: 10 }}
                  onMouseMove={handleMouseMove}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="relativeTime" 
                    type="number"
                    domain={[(dataMax: number) => (dataMax > 30 ? dataMax - 30 : 0), 'dataMax']}
                    label={{ value: 'Tempo (s)', position: 'insideBottom', offset: -5 }}
                  />
                  <YAxis 
                    domain={[
                      (dataMin: number) => Math.floor(dataMin * 10) / 10 - 0.1,
                      (dataMax: number) => Math.ceil(dataMax * 10) / 10 + 0.1
                    ]} 
                    label={{ value: 'Altitudine (m)', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip content={renderTooltip} />
                  <Legend />
                  
                  <Line 
                    type="monotone" 
                    dataKey="altitude" 
                    stroke="#673ab7" 
                    name="Altitudine" 
                    dot={false} 
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        
        {/* Visualizzazione 3D dell'orientamento */}
        <div className="border rounded p-4">
          <h3 className="text-lg font-semibold mb-4">Visualizzazione Orientamento e Accelerazione</h3>
          
          {currentPoint && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-2 bg-gray-50 rounded">
                <h4 className="font-semibold mb-2">Dati correnti (Tempo: {currentPoint.relativeTime.toFixed(2)}s)</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>AccelX:</div>
                  <div>{currentPoint.accelX.toFixed(4)}</div>
                  
                  <div>AccelY:</div>
                  <div>{currentPoint.accelY.toFixed(4)}</div>
                  
                  <div>AccelZ:</div>
                  <div>{currentPoint.accelZ.toFixed(4)}</div>
                  
                  <div>Roll:</div>
                  <div>{filterEnabled && currentPoint.roll ? currentPoint.roll.toFixed(2) : 'N/A'}°</div>
                  
                  <div>Pitch:</div>
                  <div>{filterEnabled && currentPoint.pitch ? currentPoint.pitch.toFixed(2) : 'N/A'}°</div>
                  
                  <div>Yaw:</div>
                  <div>{filterEnabled && currentPoint.yaw ? currentPoint.yaw.toFixed(2) : 'N/A'}°</div>
                  
                  <div>Altitudine:</div>
                  <div>{currentPoint.altitude.toFixed(3)} m</div>
                </div>
              </div>
              
              <div className="flex justify-center items-center">
                <canvas 
                  ref={canvasRef} 
                  width={300} 
                  height={300} 
                  className="border rounded"
                />
              </div>
            </div>
          )}
          
          <div className="mt-4 p-3 bg-blue-50 rounded border border-blue-200">
            <h4 className="font-semibold mb-2">Come utilizzare la visualizzazione:</h4>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              <li>Passa il mouse sul grafico per vedere l'orientamento del razzo in quel momento.</li>
              <li>La freccia rossa rappresenta il vettore di accelerazione.</li>
              <li>Puoi attivare/disattivare il filtro di fusione con il checkbox.</li>
              <li>Il filtro combina i dati dell'accelerometro e del giroscopio per un orientamento più stabile.</li>
              <li>Carica file diversi usando il selettore di file.</li>
            </ul>
          </div>
        </div>
      </div>
      
      {/* Sezione informativa sui filtri */}
      <div className="p-4 bg-gray-50 rounded border mb-4">
        <h3 className="text-lg font-semibold mb-2">Note sui Filtri di Fusione Implementati</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="border p-3 rounded bg-white">
            <h4 className="font-semibold text-purple-800">Filtro Complementare</h4>
            <p className="text-sm mt-2">
              Il filtro complementare combina le misurazioni dell'accelerometro (precise a lungo termine ma rumorose) 
              con quelle del giroscopio (precise a breve termine ma soggette a deriva). Il parametro alpha (0.98) 
              determina quanto pesano i dati del giroscopio rispetto a quelli dell'accelerometro.
            </p>
            <p className="text-sm mt-2">
              <strong>Vantaggi:</strong> Semplice, computazionalmente efficiente, facile da implementare.
            </p>
            <p className="text-sm mt-2">
              <strong>Svantaggi:</strong> Meno preciso durante accelerazioni non gravitazionali, non gestisce bene il rumore.
            </p>
          </div>
          
          <div className="border p-3 rounded bg-white">
            <h4 className="font-semibold text-blue-800">Filtro di Kalman</h4>
            <p className="text-sm mt-2">
              Il filtro di Kalman è un algoritmo ricorsivo che stima lo stato di un sistema dinamico da una serie di misurazioni 
              rumorose. Utilizza un modello matematico del sistema e della misurazione, insieme alle statistiche del rumore, 
              per stimare lo stato ottimale.
            </p>
            <p className="text-sm mt-2">
              <strong>Vantaggi:</strong> Gestione ottimale del rumore, stima migliore durante accelerazioni non gravitazionali, 
              può incorporare modelli fisici complessi.
            </p>
            <p className="text-sm mt-2">
              <strong>Svantaggi:</strong> Più complesso da implementare e tarare, maggiore carico computazionale.
            </p>
          </div>
          
          <div className="border p-3 rounded bg-white">
            <h4 className="font-semibold text-green-800">Filtro di Madgwick</h4>
            <p className="text-sm mt-2">
              Il filtro di Madgwick è un algoritmo di stima dell'orientamento basato sui quaternioni, progettato 
              specificamente per i sensori IMU. Utilizza un approccio di ottimizzazione del gradiente discendente 
              per correggere la deriva del giroscopio.
            </p>
            <p className="text-sm mt-2">
              <strong>Vantaggi:</strong> Computazionalmente efficiente, gestisce bene il gimbal lock, evita la 
              singolarità degli angoli di Eulero, preciso anche ad alte velocità angolari.
            </p>
            <p className="text-sm mt-2">
              <strong>Svantaggi:</strong> Richiede la regolazione del parametro beta per bilanciare la stabilità 
              e la reattività del filtro.
            </p>
          </div>
        </div>
      </div>
      {/* Tabella di confronto dei filtri */}
      <div className="p-4 bg-gray-50 rounded border">
        <h3 className="text-lg font-semibold mb-2">Confronto delle Prestazioni dei Filtri</h3>
        <p className="mb-3">
          I tre filtri implementati hanno caratteristiche e prestazioni diverse che li rendono adatti a scenari specifici:
        </p>
        
        <table className="w-full border-collapse border">
          <thead>
            <tr className="bg-gray-200">
              <th className="border p-2">Caratteristica</th>
              <th className="border p-2">Complementare</th>
              <th className="border p-2">Kalman</th>
              <th className="border p-2">Madgwick</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-2">Complessità Computazionale</td>
              <td className="border p-2">Bassa</td>
              <td className="border p-2">Alta</td>
              <td className="border p-2">Media</td>
            </tr>
            <tr>
              <td className="border p-2">Precisione con Movimenti Lenti</td>
              <td className="border p-2">Buona</td>
              <td className="border p-2">Ottima</td>
              <td className="border p-2">Buona</td>
            </tr>
            <tr>
              <td className="border p-2">Precisione con Movimenti Rapidi</td>
              <td className="border p-2">Discreta</td>
              <td className="border p-2">Buona</td>
              <td className="border p-2">Ottima</td>
            </tr>
            <tr>
              <td className="border p-2">Gestione del Rumore</td>
              <td className="border p-2">Discreta</td>
              <td className="border p-2">Ottima</td>
              <td className="border p-2">Buona</td>
            </tr>
            <tr>
              <td className="border p-2">Resistenza a Disturbi Esterni</td>
              <td className="border p-2">Bassa</td>
              <td className="border p-2">Alta</td>
              <td className="border p-2">Media</td>
            </tr>
            <tr>
              <td className="border p-2">Facilità di Implementazione</td>
              <td className="border p-2">Alta</td>
              <td className="border p-2">Bassa</td>
              <td className="border p-2">Media</td>
            </tr>
            <tr>
              <td className="border p-2">Adatto per Razzi Amatoriali</td>
              <td className="border p-2">Per voli semplici</td>
              <td className="border p-2">Per analisi precise</td>
              <td className="border p-2">Per voli acrobatici</td>
            </tr>
          </tbody>
        </table>
        
        <p className="mt-3">
          Per ottenere risultati ottimali, è possibile tarare i parametri di ciascun filtro in base alle caratteristiche 
          specifiche del razzo e dei sensori utilizzati. In un razzo reale, si potrebbe anche implementare un filtro ibrido 
          che commuta automaticamente tra diverse tecniche in base alle condizioni di volo.
        </p>
      </div>
    </div>
  );
};

export default TelemetryVisualization;