import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  price: number;
}

export interface ScheduleConfig {
  openingHours: { start: string; end: string };
  /** 0 = Sunday ... 6 = Saturday */
  closedWeekdays: number[];
  slotMinutes: number;
  services: Service[];
  maxDaysAhead?: number;
}

export interface Appointment {
  id: string;
  serviceId: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  durationMinutes: number;
  customerName: string;
  contact?: string;
  createdAt: string;
}

export class BookingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingError";
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const toHHMM = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Availability + booking store. In-memory by default; pass `persistPath`
 * to keep bookings in a JSON file between restarts.
 */
export class AppointmentStore {
  private appointments: Appointment[] = [];

  constructor(
    private readonly config: ScheduleConfig,
    private readonly opts: { now?: () => Date; persistPath?: string } = {},
  ) {
    if (opts.persistPath && existsSync(opts.persistPath)) {
      this.appointments = JSON.parse(readFileSync(opts.persistPath, "utf8")) as Appointment[];
    }
  }

  static fromFile(path: string, opts?: { now?: () => Date; persistPath?: string }): AppointmentStore {
    return new AppointmentStore(JSON.parse(readFileSync(path, "utf8")) as ScheduleConfig, opts);
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  today(): string {
    return localDate(this.now());
  }

  listServices(): Service[] {
    return this.config.services;
  }

  getService(id: string): Service | undefined {
    const key = id.trim().toLowerCase();
    return this.config.services.find((s) => s.id === key || s.name.toLowerCase() === key);
  }

  list(): Appointment[] {
    return [...this.appointments];
  }

  /** Free start times for a service on a date (business-local time). */
  getFreeSlots(date: string, serviceId: string): string[] {
    const service = this.requireService(serviceId);
    this.validateDate(date);

    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (this.config.closedWeekdays.includes(weekday)) return [];

    const open = toMinutes(this.config.openingHours.start);
    const close = toMinutes(this.config.openingHours.end);
    const now = this.now();
    const nowMins = date === localDate(now) ? now.getHours() * 60 + now.getMinutes() : -1;

    const taken = this.appointments
      .filter((a) => a.date === date)
      .map((a) => [toMinutes(a.time), toMinutes(a.time) + a.durationMinutes] as const);

    const slots: string[] = [];
    for (let start = open; start + service.durationMinutes <= close; start += this.config.slotMinutes) {
      const end = start + service.durationMinutes;
      if (start <= nowMins) continue;
      if (taken.some(([s, e]) => start < e && s < end)) continue;
      slots.push(toHHMM(start));
    }
    return slots;
  }

  book(input: { serviceId: string; date: string; time: string; customerName: string; contact?: string }): Appointment {
    const service = this.requireService(input.serviceId);
    if (!TIME_RE.test(input.time)) throw new BookingError(`Invalid time "${input.time}", expected HH:MM (24h)`);
    const name = input.customerName?.trim();
    if (!name) throw new BookingError("Customer name is required");

    const free = this.getFreeSlots(input.date, service.id);
    if (!free.includes(input.time)) {
      throw new BookingError(
        free.length > 0
          ? `${input.time} on ${input.date} is not available. Free slots: ${free.slice(0, 8).join(", ")}`
          : `No free slots for ${service.name} on ${input.date}`,
      );
    }

    const appt: Appointment = {
      id: `APT-${randomBytes(3).toString("hex").toUpperCase()}`,
      serviceId: service.id,
      date: input.date,
      time: input.time,
      durationMinutes: service.durationMinutes,
      customerName: name,
      contact: input.contact,
      createdAt: this.now().toISOString(),
    };
    this.appointments.push(appt);
    this.persist();
    return appt;
  }

  cancel(id: string): boolean {
    const before = this.appointments.length;
    this.appointments = this.appointments.filter((a) => a.id !== id.trim().toUpperCase());
    const removed = this.appointments.length < before;
    if (removed) this.persist();
    return removed;
  }

  private requireService(id: string): Service {
    const s = this.getService(id);
    if (!s) throw new BookingError(`Unknown service "${id}". Available: ${this.config.services.map((x) => x.id).join(", ")}`);
    return s;
  }

  private validateDate(date: string): void {
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new BookingError(`Invalid date "${date}", expected YYYY-MM-DD`);
    }
    const today = this.today();
    if (date < today) throw new BookingError(`${date} is in the past (today is ${today})`);
    const maxDays = this.config.maxDaysAhead ?? 60;
    const diffDays = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
    if (diffDays > maxDays) throw new BookingError(`Bookings are only open ${maxDays} days ahead`);
  }

  private persist(): void {
    if (this.opts.persistPath) writeFileSync(this.opts.persistPath, JSON.stringify(this.appointments, null, 2));
  }
}
