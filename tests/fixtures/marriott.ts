import type { RawRate, Stay } from "../../src/rates.js";

export const stay: Stay = { hotelId: "NYCMQ", checkIn: "2099-07-01", checkOut: "2099-07-03", adults: 2, children: 0, rooms: 1, usePoints: false };
export const raw: RawRate = {
  code: "KING", name: "King", ratePlanCode: "FLEX", ratePlanName: "Flexible",
  nightly: "USD 190.25", total: "USD 430.50", currency: "USD", taxesIncluded: true,
  cancellationPolicy: "Free cancellation before the deadline", cancellationDeadline: "2099-06-30T18:00:00-04:00",
  depositPolicy: "No deposit required", eligibility: "", available: true,
  bookingUrl: "https://www.marriott.com/reservation/checkout.mi", points: "",
};

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
export function stayInputs(s = stay, rate = raw): string {
  const values: Record<string, string | number> = { propertyCode: s.hotelId, fromDate: s.checkIn, toDate: s.checkOut, numberOfRooms: s.rooms, redeemPoints: String(s.usePoints), roomTypeCode: rate.code, ratePlanCode: rate.ratePlanCode };
  for (let i = 0; i < s.rooms; i++) {
    values[`guestCounts[${i}].numAdults`] = s.adults;
    values[`guestCounts[${i}].numChildren`] = s.children;
  }
  return Object.entries(values).map(([name, value]) => `<input type="hidden" name="${name}" value="${escape(String(value))}">`).join("");
}

export function terms(rate = raw): string {
  return `<span data-testid="rate-name">${escape(rate.ratePlanName)}</span>
    <span data-testid="nightly-price">${escape(rate.nightly)}</span>
    <span data-testid="total-price">${escape(rate.total)}</span>
    <p data-testid="cancellation-policy">${escape(rate.cancellationPolicy)}</p>
    <time data-testid="cancellation-deadline" datetime="${escape(rate.cancellationDeadline)}">${escape(rate.cancellationDeadline)}</time>
    <p data-testid="deposit-policy">${escape(rate.depositPolicy)}</p>
    <p data-testid="rate-eligibility">${escape(rate.eligibility)}</p>
    <span data-testid="total-points">${escape(rate.points)}</span>`;
}

export function ratePage(rates = [raw], s = stay): string {
  return `<!doctype html><html><body>${stayInputs(s)}<div data-rates-complete="true">Rates</div>
    <div data-testid="room-type-card" data-room-type-code="KING"><h2>King room</h2>
    ${rates.map(rate => `<section data-testid="rate-card" data-rate-plan-code="${rate.ratePlanCode}" data-currency="${rate.currency}" data-taxes-included="${rate.taxesIncluded}" data-available="${rate.available}">
      ${terms(rate)}<a data-testid="select-rate" href="${rate.bookingUrl}">Select</a></section>`).join("")}</div></body></html>`;
}

function currentRate(rate: RawRate, s: Stay, roomCode: string, beforeTaxNightly: number, beforeTaxTotal: number, fullNightly: number, fullTotal: number): string {
  const productId = Buffer.from([s.hotelId, rate.ratePlanCode, roomCode, s.checkIn, s.checkOut, "fixture-id"].join("|")).toString("base64url");
  const cancellation = rate.cancellationPolicy ? `<div class="taxes-fees-label">${escape(rate.cancellationPolicy)}</div>` : "";
  return `<li><div class="rate-card-content"><h4 class="title-name">${escape(rate.ratePlanName)}</h4>
    <p class="rate-description">${escape(rate.eligibility || rate.depositPolicy)}</p>${cancellation}
    <div class="taxes-fees-label d-none full-price">Taxes and all fees included</div>
    <div data-testid="ratedetails"><span class="rate-name">${rate.ratePlanCode === "GOVA" ? "Special Rate" : "Member Rate"}</span>
      <a data-testid="rate-modal" href="/reservation/ersViewRateRules.mi?rateProgramCode=${rate.ratePlanCode}&productId=${productId}&redemptionflag="></a>
      <div class="price"><span class="full-price d-none">${fullNightly}</span><span class="base-price">${beforeTaxNightly}</span><span class="avg-per-night">USD Avg / Night</span></div>
      <div class="avg-per-night full-price d-none">${fullTotal} Total Per Room</div><div class="avg-per-night base-price">${beforeTaxTotal} Total Per Room</div>
      <button aria-label="Select ${escape(rate.ratePlanName)}">Select</button></div></div></li>`;
}

/** Minimal representation of Marriott's current rateListMenu.mi DOM. */
export function currentRateListPage(s = stay): string {
  const state = { ...raw, ratePlanCode: "GOVV", ratePlanName: "Government State Rate", eligibility: "State government ID required", cancellationPolicy: "Free cancellation before or on Jun 29, 2099", cancellationDeadline: "", depositPolicy: "" };
  const federal = { ...state, ratePlanCode: "GOVA", ratePlanName: "Govt/military Rate", eligibility: "Federal government ID required" };
  return `<!doctype html><html><head><style>.d-none{display:none}</style></head><body>
    <input name="fromDate" value="${s.checkIn.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1")}"><input name="toDate" value="${s.checkOut.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1")}">
    <input name="roomCount" value="${s.rooms}"><input name="numAdultsPerRoom" value="${s.adults}"><input name="childrenCount" value="${s.children}">
    <input type="hidden" name="clusterCode" value="GOV"><input name="corporateCode" value="">
    <input type="checkbox" data-testid="showFullPrice" onchange="document.querySelectorAll('.full-price').forEach(e=>e.classList.remove('d-none'));document.querySelectorAll('.base-price').forEach(e=>e.classList.add('d-none'))">
    <div data-testid="RateCardV2"><h3 class="room-name">King room</h3>
      <a href="/reservation/ersViewRoomPool.mi?marshaCode=${s.hotelId}&roomPoolCode=genr">Room Details</a>
      <button data-testid="rate-button" onclick="this.textContent='Hide Rates';document.getElementById('current-rates').style.display='block'">View Rates</button>
      <div id="current-rates" style="display:none"><ul>${currentRate(state, s, "GENR", 109, 218, 122, 244)}${currentRate(federal, s, "GENR", 110, 220, 123, 246)}</ul></div>
    </div></body></html>`;
}

export function checkoutPage(rate = raw, s = stay, confirms = true): string {
  return `<!doctype html><html><body>${stayInputs(s, rate)}
    <div data-testid="booking-summary" data-currency="${rate.currency}" data-taxes-included="${rate.taxesIncluded}">${terms(rate)}</div>
    <input name="firstName"><input name="lastName"><input name="email"><input name="phone"><textarea name="specialRequests"></textarea>
    <button data-testid="complete-booking" onclick="window.submitted = (window.submitted || 0) + 1; ${confirms ? "document.getElementById('result').innerHTML = '<p data-testid=confirmation-number>ABC123456</p>';" : ""}">Complete Booking</button>
    <div id="result"></div></body></html>`;
}
