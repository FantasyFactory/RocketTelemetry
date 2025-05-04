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
}

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

// Funzione di utilità per convertire da gradi a radianti
const degToRad = (degrees: number): number => {
  return degrees * (Math.PI / 180);
};

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

const TelemetryVisualization: React.FC = () => {
  const [data, setData] = useState<SensorDataPoint[]>([]);
  const [filteredData, setFilteredData] = useState<SensorDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<string>('acceleration');
  const [currentPoint, setCurrentPoint] = useState<SensorDataPoint | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [filter, setFilter] = useState<boolean>(true);
  const [isRealtime, setIsRealtime] = useState<boolean>(false);
  const [realtimeInterval, setRealtimeInterval] = useState<NodeJS.Timeout | null>(null);
  const [firstFetchTimestamp, setFirstFetchTimestamp] = useState<number>(0);

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
  const fetchRealtimeData = async (): Promise<void> => {
    let retries = 3; // Numero di tentativi in caso di errore
    
    const attemptFetch = async (): Promise<void> => {
      try {
        const jsonData = await mockRocketApi();
        
        /*    
        const response = await fetch('http://192.168.4.1/imudata', {
          // Aggiungi un timeout per evitare attese infinite
          signal: AbortSignal.timeout(2000)
        });
        
        if (!response.ok) {
          throw new Error(`Errore nella richiesta: ${response.status}`);
        } 
        
        const jsonData = await response.json();
        */
        
        // Timestamp attuale in millisecondi
        const currentTimestamp = Date.now();
        
        // Crea un nuovo punto dati
        const newDataPoint: SensorDataPoint = {
          timestamp: jsonData.system.millis,
          relativeTime: (currentTimestamp - firstFetchTimestamp) / 1000, // in secondi
          accelX: jsonData.sensors.accel.x,
          accelY: jsonData.sensors.accel.y,
          accelZ: jsonData.sensors.accel.z,
          gyroX: jsonData.sensors.gyro.x,
          gyroY: jsonData.sensors.gyro.y,
          gyroZ: jsonData.sensors.gyro.z,
          // Se l'altitudine è presente nei dati, la utilizziamo, altrimenti impostiamo un valore predefinito
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
        
        // Applichiamo il filtro di fusione
        setFilteredData(prevFiltered => {
          const updatedData = [...prevFiltered, newDataPoint];
          const maxPoints = 300;
          if (updatedData.length > maxPoints) {
            return applyComplementaryFilter(updatedData.slice(updatedData.length - maxPoints));
          }
          return applyComplementaryFilter(updatedData);
        });
        
        // Aggiorniamo il punto corrente
        setCurrentPoint(prevFiltered => {
          if (prevFiltered && Array.isArray(prevFiltered) && prevFiltered.length > 0) {
            return prevFiltered[prevFiltered.length - 1];
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
    
    // Memorizziamo il timestamp del primo fetch
    setFirstFetchTimestamp(Date.now());
    
    // Puliamo i dati esistenti
    setData([]);
    setFilteredData([]);
    
    // Avviamo il polling ad intervalli regolari (ogni 100ms)
    const interval = setInterval(fetchRealtimeData, 100);
    setRealtimeInterval(interval);
    setIsRealtime(true);
  };

  // Funzione per fermare il recupero dei dati in tempo reale
  const stopRealtimeData = (): void => {
    if (realtimeInterval) {
      clearInterval(realtimeInterval);
      setRealtimeInterval(null);
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
      // Utilizziamo il tipo definito in index.d.ts per window.fs
      const fileContent = await (window as any).fs.readFile('paste.txt', { encoding: 'utf8' });
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
    
    setData(parsedData);
    
    // Applicazione del filtro di fusione
    const filteredResult = applyComplementaryFilter(parsedData);
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
    if (!ctx) return; // Assicurati che ctx non sia null
    
    const width = canvas.width;
    const height = canvas.height;
    
    // Pulisci il canvas
    ctx.clearRect(0, 0, width, height);
    
    // Centro del canvas
    const centerX = width / 2;
    const centerY = height / 2;
    
    // Converte gli angoli in radianti
    const roll = filter && currentPoint.roll ? degToRad(currentPoint.roll) : 0;
    const pitch = filter && currentPoint.pitch ? degToRad(currentPoint.pitch) : 0;
    const yaw = filter && currentPoint.yaw ? degToRad(currentPoint.yaw) : 0;
    
    // Disegna gli assi di riferimento
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
    
    ctx.save();
    ctx.translate(centerX, centerY);
    
    // Ruota di 180 gradi in pitch per mettere la punta del razzo verso l'alto inizialmente
    const initialPitch = Math.PI;
    
    // CORREZIONE: Applicazione delle rotazioni con ordine corretto per visualizzare meglio lo yaw
    // Primo passo: rotazione per lo yaw (attorno all'asse Z)
    ctx.rotate(yaw);
    
    // Secondo passo: rotazione per il pitch (attorno all'asse Y)
    ctx.rotate(pitch + initialPitch);
    
    // Terzo passo: rotazione per il roll (attorno all'asse X)
    ctx.rotate(roll);
    
    // Disegna il corpo del razzo
    ctx.fillStyle = '#d0d0d0';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(-rocketWidth / 2, -rocketLength / 2, rocketWidth, rocketLength);
    ctx.fill();
    ctx.stroke();
    
    // Disegna la punta del razzo
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.moveTo(-rocketWidth / 2, -rocketLength / 2);
    ctx.lineTo(0, -rocketLength / 2 - 20);
    ctx.lineTo(rocketWidth / 2, -rocketLength / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Disegna le alette con colori più visibili per distinguere l'orientamento
    
    // Aletta 1 (sinistra)
    ctx.fillStyle = '#4444ff';
    ctx.beginPath();
    ctx.moveTo(-rocketWidth / 2, rocketLength / 2);
    ctx.lineTo(-rocketWidth / 2 - 15, rocketLength / 2 + 20);
    ctx.lineTo(-rocketWidth / 2, rocketLength / 2 - 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Aletta 2 (destra)
    ctx.fillStyle = '#4444ff';
    ctx.beginPath();
    ctx.moveTo(rocketWidth / 2, rocketLength / 2);
    ctx.lineTo(rocketWidth / 2 + 15, rocketLength / 2 + 20);
    ctx.lineTo(rocketWidth / 2, rocketLength / 2 - 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Aletta 3 (posteriore - in diverso colore per distinguere meglio la rotazione yaw)
    ctx.fillStyle = '#44ff44';
    ctx.beginPath();
    ctx.moveTo(0, rocketLength / 2);
    ctx.lineTo(0, rocketLength / 2 + 20);
    ctx.lineTo(10, rocketLength / 2 - 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Aletta 4 (anteriore - in diverso colore per distinguere meglio la rotazione yaw)
    ctx.fillStyle = '#ff44ff';
    ctx.beginPath();
    ctx.moveTo(0, rocketLength / 2);
    ctx.lineTo(0, rocketLength / 2 + 20);
    ctx.lineTo(-10, rocketLength / 2 - 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Aggiungi un indicatore di direzione per visualizzare meglio lo yaw
    ctx.fillStyle = '#ff8800';
    ctx.beginPath();
    ctx.arc(0, -rocketLength / 2 - 10, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Disegna i vettori di accelerazione
    const accelScale = 50; // Scala per il vettore di accelerazione
    
    // Vettore X (rosso)
    const accelX = currentPoint.accelX * accelScale;
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -accelX);  // L'asse X del razzo punta verso la punta
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
    ctx.lineTo(accelY, 0);  // L'asse Y del razzo è laterale
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
    ctx.lineTo(0, accelZ);  // L'asse Z del razzo è verso la parte posteriore
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

    // Disegna la legenda
    ctx.font = '14px Arial';
    ctx.fillStyle = '#000';
    ctx.fillText('Orientamento del Razzo', width - 170, 20);
    
    const legendY = 40;
    const legendSpacing = 20;
    
    // Aggiungi alla legenda un indicatore di orientamento
    ctx.fillStyle = '#ff8800';
    ctx.fillRect(width - 170, legendY + legendSpacing * 4, 15, 15);
    ctx.fillStyle = '#000';
    ctx.fillText('Direzione (Yaw)', width - 150, legendY + legendSpacing * 4 + 12);
    
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
    
  }, [currentPoint, filter, rocketLength, rocketWidth]);
  
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
        
        <div className="flex items-center mx-2">
          <label htmlFor="filterToggle" className="mr-2">Filtro di Fusione:</label>
          <input
            type="checkbox"
            id="filterToggle"
            checked={filter}
            onChange={(e) => setFilter(e.target.checked)}
            className="w-4 h-4"
          />
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
                    domain={[0, 'dataMax']}
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
                    domain={[0, 'dataMax']}
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
              <h3 className="text-lg font-semibold mb-2">Orientamento (Filtro di Fusione)</h3>
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
                    domain={[0, 'dataMax']}
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
                    domain={[0, 'dataMax']}
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
                  <div>{filter && currentPoint.roll ? currentPoint.roll.toFixed(2) : 'N/A'}°</div>
                  
                  <div>Pitch:</div>
                  <div>{filter && currentPoint.pitch ? currentPoint.pitch.toFixed(2) : 'N/A'}°</div>
                  
                  <div>Yaw:</div>
                  <div>{filter && currentPoint.yaw ? currentPoint.yaw.toFixed(2) : 'N/A'}°</div>
                  
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
      
      <div className="p-4 bg-gray-50 rounded border">
        <h3 className="text-lg font-semibold mb-2">Note sul Filtro di Fusione</h3>
        <p className="mb-2">
          Il filtro di fusione implementato è un <strong>filtro complementare</strong> che combina le misurazioni 
          dell'accelerometro (precise a lungo termine ma rumorose) con quelle del giroscopio (precise a breve termine 
          ma soggette a deriva). Il parametro alpha (0.98) determina quanto pesano i dati del giroscopio rispetto 
          a quelli dell'accelerometro.
        </p>
        <p>
          Per un'implementazione più sofisticata in un razzo reale, sarebbe consigliabile utilizzare un 
          <strong> filtro di Kalman</strong> o un <strong>filtro di Madgwick</strong>, che offrono migliori 
          prestazioni in presenza di accelerazioni non gravitazionali e disturbi magnetici.
        </p>
      </div>
    </div>
  );
};

export default TelemetryVisualization;