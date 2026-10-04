import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAppointments } from "./helpers.js";
import { BookingError } from "../src/stores/appointments.js";

test("lists free slots within opening hours for the service duration", () => {
  const store = loadAppointments();
  const slots = store.getFreeSlots("2026-10-05", "grooming"); // 60 min, 09:00-17:00, 30 min grid
  assert.equal(slots[0], "09:00");
  assert.equal(slots.at(-1), "16:00");
  assert.equal(slots.length, 15);
});

test("closed weekdays have no slots", () => {
  assert.deepEqual(loadAppointments().getFreeSlots("2026-10-11", "nail-trim"), []); // Sunday
});

test("booking removes overlapping slots", () => {
  const store = loadAppointments();
  const appt = store.book({ serviceId: "grooming", date: "2026-10-06", time: "10:00", customerName: "Sam" });
  assert.match(appt.id, /^APT-[0-9A-F]{6}$/);
  const slots = store.getFreeSlots("2026-10-06", "nail-trim");
  assert.ok(!slots.includes("10:00") && !slots.includes("10:30"));
  assert.ok(slots.includes("09:30") && slots.includes("11:00"));
  // A 60-min service can't start at 09:30 because it would overlap 10:00.
  assert.ok(!store.getFreeSlots("2026-10-06", "grooming").includes("09:30"));
});

test("double booking is rejected with helpful alternatives", () => {
  const store = loadAppointments();
  store.book({ serviceId: "vet-checkup", date: "2026-10-06", time: "11:00", customerName: "A" });
  assert.throws(
    () => store.book({ serviceId: "vet-checkup", date: "2026-10-06", time: "11:00", customerName: "B" }),
    (e: Error) => e instanceof BookingError && /not available/.test(e.message) && /Free slots/.test(e.message),
  );
});

test("past slots on the current day are not offered", () => {
  const store = loadAppointments(() => new Date(2026, 9, 5, 12, 10));
  const slots = store.getFreeSlots("2026-10-05", "nail-trim");
  assert.equal(slots[0], "12:30");
});

test("validation: past dates, bad formats, unknown service, missing name, too far ahead", () => {
  const store = loadAppointments();
  assert.throws(() => store.getFreeSlots("2026-10-01", "grooming"), /in the past/);
  assert.throws(() => store.getFreeSlots("05/10/2026", "grooming"), /expected YYYY-MM-DD/);
  assert.throws(() => store.getFreeSlots("2026-10-06", "spa-day"), /Unknown service/);
  assert.throws(() => store.getFreeSlots("2027-03-01", "grooming"), /days ahead/);
  assert.throws(() => store.book({ serviceId: "grooming", date: "2026-10-06", time: "9am", customerName: "X" }), /Invalid time/);
  assert.throws(() => store.book({ serviceId: "grooming", date: "2026-10-06", time: "09:00", customerName: " " }), /name is required/);
});

test("cancel frees the slot again", () => {
  const store = loadAppointments();
  const appt = store.book({ serviceId: "nail-trim", date: "2026-10-07", time: "09:00", customerName: "Kim" });
  assert.ok(!store.getFreeSlots("2026-10-07", "nail-trim").includes("09:00"));
  assert.equal(store.cancel(appt.id), true);
  assert.ok(store.getFreeSlots("2026-10-07", "nail-trim").includes("09:00"));
  assert.equal(store.cancel(appt.id), false);
});
