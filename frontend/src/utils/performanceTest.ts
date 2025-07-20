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

declare global {
  interface Window {
    testStreamingPerformance: () => void;
  }
}

export const setupPerformanceTests = () => {
  if (typeof window !== 'undefined') {
    window.testStreamingPerformance = () => {
      console.log('🧪 Starting streaming performance test...');

      // Simulate rapid message updates like streaming
      const testMessage =
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
      let content = '';
      const iterations = 1000;

      console.time('Streaming Performance Test');

      for (let i = 0; i < iterations; i++) {
        content += testMessage.slice(0, Math.random() * testMessage.length);

        // Simulate what happens during streaming
        const event = new CustomEvent('streaming-test-update', {
          detail: { content, iteration: i },
        });
        document.dispatchEvent(event);
      }

      console.timeEnd('Streaming Performance Test');
      console.log(`✅ Test completed: ${iterations} updates processed`);
    };

    console.log(
      '🔧 Performance test available: window.testStreamingPerformance()'
    );
  }
};
