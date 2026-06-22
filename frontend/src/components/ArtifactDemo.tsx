/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React, { useState } from 'react';
import { ArtifactContainer } from '@/components/ArtifactContainer';
import { Button } from '@/components/ui/Button';
import { Artifact } from '@/types';

const SAMPLE_ARTIFACTS: Artifact[] = [
  {
    id: 'demo-html-1',
    type: 'html',
    title: 'Interactive Button Demo',
    description: 'A simple HTML page with interactive elements',
    content: `<div style="text-align: center; padding: 20px;">
  <h1 style="color: #333; font-family: Arial, sans-serif;">Welcome to Libre WebUI!</h1>
  <p style="color: #666; font-size: 16px;">This is an interactive HTML artifact.</p>
  <button 
    onclick="this.style.backgroundColor = this.style.backgroundColor === 'lightgreen' ? '#007bff' : 'lightgreen'; this.textContent = this.textContent === 'Clicked!' ? 'Click me!' : 'Clicked!'"
    style="background-color: #007bff; color: white; border: none; padding: 10px 20px; font-size: 16px; border-radius: 5px; cursor: pointer;">
    Click me!
  </button>
  <div style="margin-top: 20px;">
    <input type="text" placeholder="Type something..." style="padding: 8px; border: 1px solid #ccc; border-radius: 4px; margin-right: 10px;">
    <button onclick="alert('Hello from the artifact!')" style="padding: 8px 16px; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">Say Hello</button>
  </div>
</div>`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'demo-html-game-1',
    type: 'html',
    title: 'Canvas Drift Demo',
    description: 'A full HTML document with a canvas game loop',
    content: `<!DOCTYPE html>
<html>
  <head>
    <title>Canvas Drift Demo</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #050506;
        color: #f4f4f5;
        font-family: Arial, sans-serif;
      }
      canvas {
        display: block;
        width: 100vw;
        height: 100vh;
        background: radial-gradient(circle at 70% 20%, #24242a, #050506 58%);
      }
      .hud {
        position: fixed;
        left: 16px;
        top: 14px;
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
    </style>
  </head>
  <body>
    <div class="hud">Use arrow keys or WASD</div>
    <canvas id="game" width="720" height="420"></canvas>
    <script>
      const canvas = document.getElementById('game');
      const ctx = canvas.getContext('2d');
      const keys = {};
      const ship = { x: 120, y: 210, vx: 0, vy: 0, angle: 0 };
      const stars = Array.from({ length: 90 }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 1.7 + 0.4
      }));

      window.addEventListener('keydown', event => {
        keys[event.key.toLowerCase()] = true;
      });
      window.addEventListener('keyup', event => {
        keys[event.key.toLowerCase()] = false;
      });

      function tick() {
        const left = keys.arrowleft || keys.a;
        const right = keys.arrowright || keys.d;
        const up = keys.arrowup || keys.w;
        const down = keys.arrowdown || keys.s;

        ship.vx += (right ? 0.16 : 0) - (left ? 0.16 : 0);
        ship.vy += (down ? 0.16 : 0) - (up ? 0.16 : 0);
        ship.vx *= 0.985;
        ship.vy *= 0.985;
        ship.x = (ship.x + ship.vx + canvas.width) % canvas.width;
        ship.y = (ship.y + ship.vy + canvas.height) % canvas.height;
        ship.angle = Math.atan2(ship.vy, ship.vx || 0.01);
      }

      function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        stars.forEach(star => {
          ctx.globalAlpha = 0.35 + star.r / 3;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.globalAlpha = 1;

        ctx.save();
        ctx.translate(ship.x, ship.y);
        ctx.rotate(ship.angle);
        ctx.fillStyle = '#a1a1aa';
        ctx.strokeStyle = '#f4f4f5';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(18, 0);
        ctx.lineTo(-14, -11);
        ctx.lineTo(-8, 0);
        ctx.lineTo(-14, 11);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      function loop() {
        tick();
        draw();
        requestAnimationFrame(loop);
      }
      loop();
    </script>
  </body>
</html>`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'demo-svg-1',
    type: 'svg',
    title: 'Animated SVG Logo',
    description: 'An animated SVG graphic',
    content: `<svg width="200" height="200" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <circle cx="100" cy="100" r="80" fill="none" stroke="#007bff" stroke-width="4">
    <animate attributeName="r" values="80;90;80" dur="2s" repeatCount="indefinite"/>
  </circle>
  <circle cx="100" cy="100" r="50" fill="#007bff" opacity="0.3">
    <animate attributeName="opacity" values="0.3;0.7;0.3" dur="2s" repeatCount="indefinite"/>
  </circle>
  <text x="100" y="110" text-anchor="middle" fill="#333" font-family="Arial, sans-serif" font-size="18" font-weight="bold">
    Libre WebUI
  </text>
</svg>`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'demo-json-1',
    type: 'json',
    title: 'Configuration Data',
    description: 'Sample configuration JSON',
    content: `{
  "application": {
    "name": "Libre WebUI",
    "version": "1.0.0",
    "description": "Privacy-first AI chat interface"
  },
  "features": {
    "artifacts": true,
    "multiModal": true,
    "plugins": true,
    "darkMode": true
  },
  "models": [
    {
      "name": "llama3.2",
      "type": "chat",
      "parameters": {
        "temperature": 0.7,
        "max_tokens": 2048
      }
    },
    {
      "name": "codellama",
      "type": "code",
      "parameters": {
        "temperature": 0.1,
        "max_tokens": 4096
      }
    }
  ],
  "ui": {
    "theme": "auto",
    "sidebar": {
      "collapsed": false,
      "width": 320
    }
  }
}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'demo-code-1',
    type: 'code',
    language: 'python',
    title: 'Data Processing Script',
    description: 'A Python script for processing data',
    content: `import pandas as pd
import numpy as np
from datetime import datetime

def process_data(filename):
    """
    Process CSV data and return insights
    """
    try:
        # Read the CSV file
        df = pd.read_csv(filename)
        
        # Basic statistics
        stats = {
            'total_rows': len(df),
            'total_columns': len(df.columns),
            'missing_values': df.isnull().sum().sum(),
            'processed_at': datetime.now().isoformat()
        }
        
        # Data types summary
        type_summary = df.dtypes.value_counts().to_dict()
        stats['data_types'] = {str(k): v for k, v in type_summary.items()}
        
        # Numerical columns summary
        numeric_cols = df.select_dtypes(include=[np.number]).columns
        if len(numeric_cols) > 0:
            stats['numeric_summary'] = df[numeric_cols].describe().to_dict()
        
        return stats
        
    except Exception as e:
        return {'error': str(e)}

# Example usage
if __name__ == "__main__":
    result = process_data('data.csv')
    print("Data processing results:")
    print(result)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

export const ArtifactDemo: React.FC = () => {
  const [selectedArtifacts, setSelectedArtifacts] = useState<Artifact[]>([
    SAMPLE_ARTIFACTS[0],
  ]);

  const addArtifact = (artifact: Artifact) => {
    if (!selectedArtifacts.find(a => a.id === artifact.id)) {
      setSelectedArtifacts([...selectedArtifacts, artifact]);
    }
  };

  const removeArtifact = (artifactId: string) => {
    setSelectedArtifacts(selectedArtifacts.filter(a => a.id !== artifactId));
  };

  return (
    <div className='max-w-6xl mx-auto p-6 text-gray-900 dark:text-dark-800'>
      <div className='mb-8'>
        <h1 className='text-3xl font-bold text-gray-900 dark:text-gray-100 mb-4'>
          Artifacts Demo
        </h1>
        <p className='text-gray-600 dark:text-gray-400 text-lg'>
          This demonstrates the Artifacts feature - interactive content that can
          be rendered alongside chat messages. Try the different artifact types
          below.
        </p>
      </div>

      <div className='grid grid-cols-1 lg:grid-cols-4 gap-6'>
        {/* Artifact Selection */}
        <div className='lg:col-span-1'>
          <h2 className='text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4'>
            Available Artifacts
          </h2>
          <div className='space-y-2'>
            {SAMPLE_ARTIFACTS.map(artifact => (
              <div
                key={artifact.id}
                className='flex items-center justify-between p-3 bg-white dark:bg-dark-200 border border-gray-200 dark:border-dark-300 rounded-lg'
              >
                <div className='flex-1 min-w-0'>
                  <h3 className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>
                    {artifact.title}
                  </h3>
                  <p className='text-xs text-gray-500 dark:text-gray-400 uppercase'>
                    {artifact.type}
                  </p>
                </div>
                <Button
                  size='sm'
                  variant={
                    selectedArtifacts.find(a => a.id === artifact.id)
                      ? 'outline'
                      : 'primary'
                  }
                  onClick={() => {
                    if (selectedArtifacts.find(a => a.id === artifact.id)) {
                      removeArtifact(artifact.id);
                    } else {
                      addArtifact(artifact);
                    }
                  }}
                >
                  {selectedArtifacts.find(a => a.id === artifact.id)
                    ? 'Remove'
                    : 'Add'}
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* Artifact Display */}
        <div className='lg:col-span-3'>
          <h2 className='text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4'>
            Selected Artifacts ({selectedArtifacts.length})
          </h2>
          {selectedArtifacts.length > 0 ? (
            <ArtifactContainer artifacts={selectedArtifacts} />
          ) : (
            <div className='text-center py-12 text-gray-500 dark:text-gray-400'>
              <p>
                No artifacts selected. Choose some from the left panel to see
                them in action.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Usage Information */}
      <div className='mt-12 bg-white dark:bg-dark-25 border border-gray-200 dark:border-dark-300 rounded-lg p-6'>
        <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-900 mb-3'>
          How Artifacts Work
        </h3>
        <div className='text-sm text-gray-700 dark:text-dark-700 space-y-2'>
          <p>
            <strong>Automatic Detection:</strong> When an AI model returns code
            blocks with specific languages (HTML, SVG, Python, etc.), they are
            automatically converted into interactive artifacts.
          </p>
          <p>
            <strong>Supported Types:</strong> HTML pages, SVG graphics, JSON
            data, code snippets, React components, and more.
          </p>
          <p>
            <strong>Interactive Features:</strong> View in fullscreen, copy
            content, download files, and open in new windows.
          </p>
          <p>
            <strong>Safe Rendering:</strong> All artifacts are rendered in
            sandboxed environments for security.
          </p>
        </div>
      </div>
    </div>
  );
};
