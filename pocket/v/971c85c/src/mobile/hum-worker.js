// Module Worker: hum take analysis (see hum-analysis.js for the protocol).
import { handleAnalysisMessage } from './hum-analysis.js';

self.onmessage = (e) => handleAnalysisMessage(e.data, (msg) => self.postMessage(msg));
