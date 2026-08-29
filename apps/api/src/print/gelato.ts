import { createDownloadUrl } from "../storage";
import { env } from "../env";

interface GelatoOrderInput {
  id: string;
  shippingName: string;
  shippingLine1: string;
  shippingLine2: string | null;
  shippingCity: string;
  shippingPostalCode: string;
  shippingCountry: string;
  items: { id: string; bookTitle: string; printPdfKey: string }[];
}

// WRITTEN FROM GELATO'S COMMONLY-DOCUMENTED v4 ORDER-CREATE API SHAPE. There is
// no Gelato account to verify this against yet (see the post-build checklist).
// Once you have API credentials, place one real test order and diff the actual
// required/returned fields against this function before relying on it —
// treat the URL, field names, and response shape below as a strong starting
// point, not a confirmed contract.
const GELATO_ORDERS_URL = "https://order.gelatoapis.com/v4/orders";

export async function submitOrderToGelato(order: GelatoOrderInput): Promise<{ gelatoOrderId: string }> {
  const items = await Promise.all(
    order.items.map(async (item) => ({
      itemReferenceId: item.id,
      productUid: env.GELATO_PRODUCT_UID,
      files: [{ type: "default", url: await createDownloadUrl(item.printPdfKey, 3600) }],
      quantity: 1,
    })),
  );

  const response = await fetch(GELATO_ORDERS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": env.GELATO_API_KEY ?? "",
    },
    body: JSON.stringify({
      orderReferenceId: order.id,
      currency: "EUR",
      items,
      shippingAddress: {
        firstName: order.shippingName,
        addressLine1: order.shippingLine1,
        addressLine2: order.shippingLine2 ?? undefined,
        city: order.shippingCity,
        postCode: order.shippingPostalCode,
        country: order.shippingCountry,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gelato order create failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { id?: string; orderId?: string };
  const gelatoOrderId = data.id ?? data.orderId;
  if (!gelatoOrderId) {
    throw new Error(`Gelato order create response had no id/orderId field: ${JSON.stringify(data)}`);
  }
  return { gelatoOrderId };
}
