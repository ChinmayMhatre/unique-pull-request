import fs from 'fs/promises';
import path from 'path';

export class AuditLogger {
  public logDir: string;
  public phaseTimings: Record<string, number> = {};
  private startTime: number;

  constructor(repo: string) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const safeRepo = repo.replace('/', '_');
    this.logDir = path.join(process.cwd(), 'logs', `${safeRepo}_${ts}`);
    this.startTime = Date.now();
  }

  async init(config: object) {
    await fs.mkdir(this.logDir, { recursive: true });
    await this.write('00_run_config.json', { ...config, logDir: this.logDir });
    console.log(`   📁 Logs → ${this.logDir}\n`);
  }

  async write(filename: string, data: object) {
    const filepath = path.join(this.logDir, filename);
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`   💾 ${filename}`);
  }

  markPhase(name: string) {
    this.phaseTimings[name] = Date.now();
  }

  phaseMs(name: string): number {
    return this.phaseTimings[name] ? Date.now() - this.phaseTimings[name] : 0;
  }

  elapsedMs(): number {
    return Date.now() - this.startTime;
  }
}
