import type { Catalog, Product } from "../stores/catalog.js";
import type { AppointmentStore } from "../stores/appointments.js";
import type { Tool } from "./types.js";

const publicProduct = (p: Product) => ({
  id: p.id,
  name: p.name,
  category: p.category,
  price: p.price,
  in_stock: p.stock > 0,
  stock: p.stock,
  description: p.description,
});

export function createTools(deps: { catalog: Catalog; appointments: AppointmentStore }): Tool<any>[] {
  const { catalog, appointments } = deps;

  const searchProducts: Tool<{ query?: string; category?: string; max_price?: number; in_stock_only?: boolean }> = {
    name: "search_products",
    description:
      "Search the store's product catalog. Use for any question about what products are available, prices, or recommendations. " +
      "Returns up to 5 best matches.",
    parameters: {
      query: { type: "string", description: "Free-text keywords, e.g. 'grain free dog food' or 'cat toy'" },
      category: { type: "string", description: "Optional category filter", enum: catalog.categories() },
      max_price: { type: "number", description: "Optional maximum price (USD)" },
      in_stock_only: { type: "boolean", description: "Only return products currently in stock" },
    },
    handler: (a) => {
      const results = catalog.search({ query: a.query, category: a.category, maxPrice: a.max_price, inStockOnly: a.in_stock_only });
      return { count: results.length, results: results.map(publicProduct) };
    },
  };

  const getProduct: Tool<{ product_id: string }> = {
    name: "get_product_details",
    description: "Get full details of a single product by its id (e.g. 'P003'). Use to answer specific follow-up questions.",
    parameters: { product_id: { type: "string", description: "Product id from search results" } },
    required: ["product_id"],
    handler: (a) => {
      const p = catalog.getById(a.product_id);
      return p ? { product: { ...publicProduct(p), tags: p.tags } } : { error: `No product with id ${a.product_id}` };
    },
  };

  const listServices: Tool<Record<string, never>> = {
    name: "list_services",
    description: "List bookable in-store services (grooming, vet check-ups, ...) with duration and price.",
    parameters: {},
    handler: () => ({ services: appointments.listServices() }),
  };

  const serviceIds = appointments.listServices().map((s) => s.id);

  const checkAvailability: Tool<{ date: string; service_id: string }> = {
    name: "check_availability",
    description: "List free appointment start times for a service on a given date. Always call this before booking.",
    parameters: {
      date: { type: "string", description: "Date in YYYY-MM-DD format" },
      service_id: { type: "string", description: "Service id", enum: serviceIds },
    },
    required: ["date", "service_id"],
    handler: (a) => {
      const slots = appointments.getFreeSlots(a.date, a.service_id);
      return { date: a.date, service_id: a.service_id, free_slots: slots, closed: slots.length === 0 };
    },
  };

  const bookAppointment: Tool<{ date: string; time: string; service_id: string; customer_name: string; contact?: string }> = {
    name: "book_appointment",
    description:
      "Book an appointment. Only call after the customer has explicitly confirmed the service, date, time and their name.",
    parameters: {
      date: { type: "string", description: "Date in YYYY-MM-DD format" },
      time: { type: "string", description: "Start time in HH:MM (24h), must be one of the free slots" },
      service_id: { type: "string", description: "Service id", enum: serviceIds },
      customer_name: { type: "string", description: "Customer's name" },
      contact: { type: "string", description: "Optional phone/email. Defaults to the chat sender." },
    },
    required: ["date", "time", "service_id", "customer_name"],
    handler: (a, ctx) => {
      const appt = appointments.book({
        serviceId: a.service_id,
        date: a.date,
        time: a.time,
        customerName: a.customer_name,
        contact: a.contact ?? (ctx.channel === "whatsapp" ? ctx.customerId : undefined),
      });
      const service = appointments.getService(appt.serviceId);
      return { confirmed: true, appointment: { ...appt, service_name: service?.name, price: service?.price } };
    },
  };

  return [searchProducts, getProduct, listServices, checkAvailability, bookAppointment];
}
