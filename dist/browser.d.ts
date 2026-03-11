/**
 * Strider Labs - Marriott Browser Automation
 *
 * Playwright-based browser automation for Marriott hotel booking operations.
 */
import { type SessionInfo } from "./auth.js";
export interface HotelResult {
    id: string;
    name: string;
    brand?: string;
    url?: string;
    starRating?: number;
    guestRating?: string;
    reviewCount?: number;
    location?: string;
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    pricePerNight?: string;
    totalPrice?: string;
    imageUrl?: string;
    freeCancellation?: boolean;
    bonvoyBonus?: boolean;
    distanceFromCenter?: string;
}
export interface HotelDetails extends HotelResult {
    description?: string;
    amenities?: string[];
    roomTypes?: RoomOption[];
    checkInTime?: string;
    checkOutTime?: string;
    policies?: string[];
    phone?: string;
    lat?: number;
    lng?: number;
    nearbyAttractions?: string[];
    parkingInfo?: string;
    petPolicy?: string;
}
export interface RoomOption {
    code: string;
    name: string;
    description?: string;
    maxGuests?: number;
    bedType?: string;
    sqft?: number;
    view?: string;
    pricePerNight?: string;
    totalPrice?: string;
    ratePlanCode?: string;
    ratePlanName?: string;
    freeCancellation?: boolean;
    breakfastIncluded?: boolean;
    pointsEarned?: number;
    pointsRequired?: number;
    available?: boolean;
    imageUrl?: string;
}
export interface Extra {
    type: "parking" | "breakfast" | "late_checkout" | "early_checkin" | "airport_transfer" | "spa_credit";
    name: string;
    description?: string;
    price?: string;
    selected?: boolean;
}
export interface Reservation {
    confirmationNumber: string;
    status: string;
    hotelName: string;
    hotelAddress?: string;
    checkIn: string;
    checkOut: string;
    roomType: string;
    guests?: number;
    totalPrice?: string;
    cancellationPolicy?: string;
    bonvoyPointsEarned?: number;
    extras?: Extra[];
    guestName?: string;
}
export interface BonvoyStatus {
    memberNumber?: string;
    memberName?: string;
    tier?: string;
    points?: number;
    nightsThisYear?: number;
    nightsToNextTier?: number;
    nextTier?: string;
    expirationDate?: string;
    recentActivity?: Array<{
        date: string;
        description: string;
        points: number;
    }>;
}
export interface StayHistory {
    stays: Array<{
        confirmationNumber: string;
        hotelName: string;
        location?: string;
        checkIn: string;
        checkOut: string;
        nights: number;
        roomType?: string;
        pointsEarned?: number;
        totalCost?: string;
        status: string;
    }>;
    totalStays: number;
    totalNights: number;
}
export declare function closeBrowser(): Promise<void>;
export declare function checkLoginStatus(): Promise<SessionInfo>;
export declare function initiateLogin(): Promise<{
    message: string;
    loginUrl: string;
    instructions: string;
}>;
export declare function searchHotels(params: {
    destination: string;
    checkIn: string;
    checkOut: string;
    adults?: number;
    children?: number;
    rooms?: number;
    maxResults?: number;
}): Promise<HotelResult[]>;
export declare function getHotelDetails(hotelIdOrUrl: string): Promise<HotelDetails>;
export declare function getRoomOptions(params: {
    hotelId: string;
    checkIn: string;
    checkOut: string;
    adults?: number;
    children?: number;
    usePoints?: boolean;
}): Promise<RoomOption[]>;
export declare function selectRoom(params: {
    hotelId: string;
    roomCode: string;
    ratePlanCode?: string;
}): Promise<{
    success: boolean;
    message: string;
    nextStep: string;
}>;
export declare function addExtras(params: {
    extras: Array<"parking" | "breakfast" | "late_checkout" | "early_checkin" | "airport_transfer" | "spa_credit">;
}): Promise<{
    success: boolean;
    selectedExtras: string[];
    message: string;
}>;
export declare function checkout(params: {
    hotelId?: string;
    roomCode?: string;
    checkIn: string;
    checkOut: string;
    adults?: number;
    children?: number;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    specialRequests?: string;
    confirm?: boolean;
}): Promise<{
    requiresConfirmation: true;
    preview: object;
} | {
    success: boolean;
    confirmationNumber?: string;
    message: string;
}>;
export declare function getReservation(confirmationNumber?: string): Promise<Reservation[]>;
export declare function modifyReservation(params: {
    confirmationNumber: string;
    newCheckIn?: string;
    newCheckOut?: string;
    newRoomType?: string;
    specialRequests?: string;
    confirm?: boolean;
}): Promise<{
    requiresConfirmation: true;
    preview: object;
} | {
    success: boolean;
    message: string;
}>;
export declare function cancelReservation(params: {
    confirmationNumber: string;
    confirm?: boolean;
}): Promise<{
    requiresConfirmation: true;
    preview: object;
} | {
    success: boolean;
    cancellationNumber?: string;
    message: string;
}>;
export declare function checkIn(params: {
    confirmationNumber: string;
    estimatedArrivalTime?: string;
    roomPreferences?: string;
}): Promise<{
    success: boolean;
    message: string;
    roomNumber?: string;
    mobileKeyAvailable?: boolean;
}>;
export declare function getBonvoyStatus(): Promise<BonvoyStatus>;
export declare function redeemPoints(params: {
    hotelId: string;
    checkIn: string;
    checkOut: string;
    adults?: number;
    roomCode?: string;
    confirm?: boolean;
}): Promise<{
    requiresConfirmation: true;
    preview: object;
} | {
    success: boolean;
    confirmationNumber?: string;
    pointsUsed?: number;
    message: string;
}>;
export declare function getStayHistory(params: {
    limit?: number;
}): Promise<StayHistory>;
