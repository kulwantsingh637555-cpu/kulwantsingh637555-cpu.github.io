/* =====================================================
   SMART VEGETABLE STORE
   Firestore = shared inventory source of truth
   LocalStorage = offline cache / first-time migration only
   ===================================================== */

import { db, auth, secondaryAuth } from "./firebase.js";
import {
    collection, doc, setDoc, deleteDoc, getDocs, getDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

let items = JSON.parse(localStorage.getItem("vegetableItems") || "[]");
let invoiceItems = JSON.parse(localStorage.getItem("invoiceItems") || "[]");
let unsubscribeInventory = null;
let cloudReady = false;
let toastTimer = null;
let currentProfile = null;

/* ================= AUTH + PAGE LOAD ================= */

const ADMIN_LOGIN_ID = "superadmin";
const ADMIN_EMAIL = "superadmin@smartvegetablestore.com";
const ADMIN_PASSWORD = "superadmin@1234";
const INVENTORY_COLLECTION = "vegetableItems";

function loginEmailFromId(userId) {
    const id = String(userId || "").trim().toLowerCase();
    if (id === ADMIN_LOGIN_ID) return ADMIN_EMAIL;
    return `${id}@smartvegetablestore.local`;
}

function setAuthMessage(message, error = false) {
    const el = document.getElementById("loginMessage");
    if (el) {
        el.textContent = message;
        el.className = "login-message" + (error ? " error" : "");
    }
}

function setAdminMessage(message, error = false) {
    const el = document.getElementById("adminMessage");
    if (el) {
        el.textContent = message;
        el.className = "login-message" + (error ? " error" : "");
    }
}

function showApp() {
    document.getElementById("authScreen")?.classList.add("hidden");
}

function showLogin() {
    document.getElementById("authScreen")?.classList.remove("hidden");
    document.querySelector(".app")?.classList.add("app-locked");
}

async function loginUser() {
    const userId = document.getElementById("loginUserId")?.value.trim().toLowerCase();
    const password = document.getElementById("loginPassword")?.value || "";
    if (!userId || !password) return setAuthMessage("User ID और Password दोनों भरें।", true);

    setAuthMessage("Login हो रहा है...");
    try {
        const email = loginEmailFromId(userId);
        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (loginError) {
            // First login: automatically create the fixed Super Admin account.
            // This removes the need to manually create the Super Admin in Firebase Auth.
            if (userId === ADMIN_LOGIN_ID && password === ADMIN_PASSWORD &&
                ["auth/user-not-found", "auth/invalid-credential"].includes(loginError?.code)) {
                await createUserWithEmailAndPassword(auth, ADMIN_EMAIL, ADMIN_PASSWORD);
            } else {
                throw loginError;
            }
        }
    } catch (error) {
        console.error("Login error:", error);
        const code = error?.code || "";
        let msg = "Login नहीं हुआ। User ID या Password check करें।";
        if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") msg = "User ID या Password गलत है।";
        if (code === "auth/too-many-requests") msg = "बहुत ज्यादा कोशिशें हुई हैं। थोड़ी देर बाद फिर try करें।";
        if (code === "auth/operation-not-allowed") msg = "Firebase Authentication में Email/Password enable करें।";
        setAuthMessage(msg, true);
    }
}

async function logoutUser() {
    if (unsubscribeInventory) { unsubscribeInventory(); unsubscribeInventory = null; }
    cloudReady = false;
    await signOut(auth);
}

async function handleAuthenticatedUser(user) {
    if (!user) {
        showLogin();
        document.getElementById("currentUserLabel").textContent = "-";
        return;
    }

    try {
        const userRef = doc(db, "users", user.uid);
        const profileSnap = await getDoc(userRef);
        let profile;

        // The only automatic admin bootstrap is the fixed Super Admin account.
        // Create this account once in Firebase Authentication with the email below.
        if (!profileSnap.exists() && user.email === ADMIN_EMAIL) {
            profile = {
                uid: user.uid,
                userId: ADMIN_LOGIN_ID,
                email: user.email,
                role: "superadmin",
                active: true,
                createdAt: Date.now()
            };
            await setDoc(userRef, profile);
        } else if (!profileSnap.exists()) {
            await signOut(auth);
            setAuthMessage("यह User अभी Super Admin ने create नहीं किया है।", true);
            return;
        } else {
            profile = profileSnap.data();
        }

        if (profile.active !== true) {
            await signOut(auth);
            setAuthMessage("यह account अभी Disabled है। Super Admin से contact करें।", true);
            return;
        }

        currentProfile = profile;
        showApp();
        document.querySelector(".app")?.classList.remove("app-locked");
        document.getElementById("currentUserLabel").textContent = `${profile.userId || user.email}${profile.role === "superadmin" ? " (Super Admin)" : ""}`;
        const adminBtn = document.getElementById("adminNavBtn");
        if (adminBtn) adminBtn.style.display = profile.role === "superadmin" ? "block" : "none";

        setTodayDate();
        renderTable();
        updateDashboard();
        renderInvoice();
        await connectCloudInventory();
        if (profile.role === "superadmin") await loadUsers();
    } catch (error) {
        console.error("Profile error:", error);
        await signOut(auth);
        setAuthMessage("Account profile load नहीं हुआ। Firestore Rules check करें।", true);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    setTodayDate();
    renderTable();
    updateDashboard();
    renderInvoice();
    showLogin();
    onAuthStateChanged(auth, handleAuthenticatedUser);
});

/* ================= CLOUD SYNC ================= */

async function connectCloudInventory() {
    setSyncStatus("⏳ Connecting to cloud...", false);
    if (unsubscribeInventory) { unsubscribeInventory(); unsubscribeInventory = null; }
    if (!auth.currentUser) return;

    try {
        const snap = await getDocs(collection(db, INVENTORY_COLLECTION));

        // Keep old data: if the shared collection is empty, Super Admin's old local data can be migrated.
        if (snap.empty && currentProfile?.role === "superadmin" && items.length > 0) {
            for (const item of items) {
                const id = item.id || makeId();
                item.id = id;
                await setDoc(doc(db, INVENTORY_COLLECTION, id), sanitizeItem(item));
            }
        }

        if (!snap.empty) {
            items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            cacheItems();
            renderTable();
            updateDashboard();
        }

        subscribeToInventory();
        cloudReady = true;
        setSyncStatus("☁️ Cloud sync ON", true);
    } catch (error) {
        console.error("Firebase connection error:", error);
        cloudReady = false;
        setSyncStatus("⚠️ Cloud sync unavailable", false);
        showFirebaseError(error);
    }
}

function subscribeToInventory() {
    if (unsubscribeInventory) unsubscribeInventory();
    if (!auth.currentUser) return;
    unsubscribeInventory = onSnapshot(
        collection(db, INVENTORY_COLLECTION),
        snapshot => {
            items = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            cacheItems();
            renderTable();
            updateDashboard();
            renderInvoice();
            setSyncStatus("☁️ Cloud sync ON", true);
        },
        error => {
            console.error("Inventory listener error:", error);
            setSyncStatus("⚠️ Sync error", false);
        }
    );
}

async function saveItemToCloud(item) {
    if (!auth.currentUser || !currentProfile?.active) throw new Error("Cloud login not ready");
    const id = item.id || makeId();
    const clean = sanitizeItem({ ...item, id });
    await setDoc(doc(db, INVENTORY_COLLECTION, id), clean);
    return id;
}

async function deleteItemFromCloud(id) {
    await deleteDoc(doc(db, INVENTORY_COLLECTION, id));
}

function sanitizeItem(item) {
    return {
        name: String(item.name || "").trim(),
        category: String(item.category || "Vegetable"),
        date: String(item.date || ""),
        stockIn: Number(item.stockIn) || 0,
        stockOut: Number(item.stockOut) || 0,
        buyPrice: Number(item.buyPrice) || 0,
        sellPrice: Number(item.sellPrice) || 0,
        updatedAt: Date.now(),
        updatedBy: auth.currentUser?.uid || ""
    };
}

function showFirebaseError(error) {
    const code = error?.code || "unknown";
    console.error("Firebase error code:", code, "message:", error?.message || error);
    let message = "Firebase connect नहीं हुआ।";
    if (code === "auth/operation-not-allowed") message = "Firebase Authentication में Email/Password ON करें।";
    else if (code === "auth/invalid-api-key" || code === "auth/api-key-not-valid") message = "Firebase API key invalid है। Firebase Console से सही Web App config डालें।";
    else if (code === "auth/unauthorized-domain") message = "GitHub Pages domain Firebase Authentication के Authorized Domains में add करें।";
    else if (code === "permission-denied" || code === "firestore/permission-denied") message = "Firestore Rules में इस account की permission check करें।";
    else if (code === "failed-precondition") message = "Firestore database create/enable करें।";
    const el = document.getElementById("syncStatus");
    if (el) el.title = message;
}

async function retryCloudSync() { await connectCloudInventory(); }

/* ================= USER MANAGEMENT ================= */

function assertAdmin() {
    if (currentProfile?.role !== "superadmin" || currentProfile?.active !== true) {
        throw new Error("Super Admin permission required");
    }
}

async function createManagedUser() {
    try {
        assertAdmin();
        const userId = document.getElementById("newUserId")?.value.trim().toLowerCase();
        const password = document.getElementById("newUserPassword")?.value || "";
        if (!/^[a-z0-9._-]{3,30}$/.test(userId || "")) return setAdminMessage("User ID में 3-30 letters/numbers और . _ - ही रखें।", true);
        if (userId === ADMIN_LOGIN_ID) return setAdminMessage("superadmin reserved User ID है।", true);
        if (password.length < 6) return setAdminMessage("Password कम से कम 6 characters का होना चाहिए।", true);

        setAdminMessage("User create हो रहा है...");
        const credential = await createUserWithEmailAndPassword(secondaryAuth, loginEmailFromId(userId), password);
        await setDoc(doc(db, "users", credential.user.uid), {
            uid: credential.user.uid,
            userId,
            email: credential.user.email,
            role: "user",
            active: true,
            createdAt: Date.now(),
            createdBy: auth.currentUser.uid
        });
        await signOut(secondaryAuth);
        document.getElementById("newUserId").value = "";
        document.getElementById("newUserPassword").value = "";
        setAdminMessage(`User ${userId} successfully create हो गया।`);
        await loadUsers();
    } catch (error) {
        console.error("Create user error:", error);
        let msg = error.message || "User create नहीं हुआ।";
        if (error.code === "auth/email-already-in-use") msg = "यह User ID पहले से मौजूद है।";
        if (error.code === "auth/weak-password") msg = "Password बहुत weak है।";
        setAdminMessage(msg, true);
        try { await signOut(secondaryAuth); } catch (_) {}
    }
}

async function loadUsers() {
    if (currentProfile?.role !== "superadmin") return;
    const list = document.getElementById("usersList");
    if (!list) return;
    try {
        const snap = await getDocs(collection(db, "users"));
        const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (!users.length) { list.innerHTML = "<p>No users found.</p>"; return; }
        users.sort((a,b) => (a.userId || "").localeCompare(b.userId || ""));
        list.innerHTML = users.map(u => `
          <div class="user-row">
            <div><strong>${escapeHTML(u.userId || "")}</strong><small>${escapeHTML(u.role || "user")} · ${escapeHTML(u.email || "")}</small></div>
            <div class="user-actions">
              ${u.role === "superadmin" ? '<span class="admin-tag">SUPER ADMIN</span>' : `<button class="small-btn" onclick="toggleManagedUser('${u.id}', ${u.active !== true})">${u.active === true ? "Disable" : "Enable"}</button><button class="small-delete" onclick="removeManagedUser('${u.id}')">Remove</button>`}
            </div>
          </div>`).join("");
    } catch (error) {
        console.error(error);
        list.innerHTML = "<p>Users load नहीं हुए। Rules check करें।</p>";
    }
}

async function toggleManagedUser(uid, makeActive) {
    try {
        assertAdmin();
        await setDoc(doc(db, "users", uid), { active: !!makeActive, updatedAt: Date.now() }, { merge: true });
        await loadUsers();
        showToast(makeActive ? "User enabled." : "User disabled.");
    } catch (error) { alert("User status change नहीं हुआ।"); }
}

async function removeManagedUser(uid) {
    try {
        assertAdmin();
        if (!confirm("इस user को app/website access से remove करना है?")) return;
        await deleteDoc(doc(db, "users", uid));
        await loadUsers();
        showToast("User access remove हो गया।");
    } catch (error) { alert("User remove नहीं हुआ।"); }
}


/* ================= DATE ================= */

function setTodayDate() {
    const today = new Date();
    const formattedDate = today.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
    });

    const todayDate = document.getElementById("todayDate");
    if (todayDate) todayDate.innerText = formattedDate;

    const invoiceDate = document.getElementById("invoiceDate");
    if (invoiceDate) invoiceDate.innerText = "Date: " + formattedDate;
}

/* ================= SECTION ================= */

function showSection(sectionName) {
    document.querySelectorAll(".section").forEach(section => {
        section.classList.remove("active-section");
    });

    const selectedSection = document.getElementById(sectionName);
    if (selectedSection) selectedSection.classList.add("active-section");

    document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.classList.remove("active");
    });

    const navButtons = document.querySelectorAll(".nav-btn");
    const map = { dashboard: 0, inventory: 1, invoice: 2, admin: 3 };

    if (navButtons[map[sectionName]]) {
        navButtons[map[sectionName]].classList.add("active");
    }

    if (sectionName === "inventory") renderTable();
    if (sectionName === "invoice") renderInvoice();
    if (sectionName === "admin" && currentProfile?.role === "superadmin") loadUsers();

    window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ================= MODAL ================= */

function openAddModal() {
    document.getElementById("modalTitle").innerText = "Add Vegetable";
    document.getElementById("editIndex").value = "";
    document.getElementById("itemName").value = "";
    document.getElementById("itemCategory").value = "Vegetable";
    document.getElementById("itemDate").value = new Date().toISOString().split("T")[0];
    document.getElementById("stockIn").value = "";
    document.getElementById("stockOut").value = "";
    document.getElementById("buyPrice").value = "";
    document.getElementById("sellPrice").value = "";
    document.getElementById("itemModal").classList.add("show");
}

function closeModal() {
    document.getElementById("itemModal").classList.remove("show");
}

/* ================= SAVE ITEM ================= */

async function saveItem() {
    const name = document.getElementById("itemName").value.trim();
    const category = document.getElementById("itemCategory").value;
    const date = document.getElementById("itemDate").value;
    const stockIn = Number(document.getElementById("stockIn").value) || 0;
    const stockOut = Number(document.getElementById("stockOut").value) || 0;
    const buyPrice = Number(document.getElementById("buyPrice").value) || 0;
    const sellPrice = Number(document.getElementById("sellPrice").value) || 0;
    const editIndex = document.getElementById("editIndex").value;

    if (!name) return alert("Please enter vegetable name!");
    if (!date) return alert("Please select date!");
    if (stockIn < 0 || stockOut < 0) return alert("Stock cannot be negative!");
    if (buyPrice < 0 || sellPrice < 0) return alert("Price cannot be negative!");

    // Prevent selling more than available stock.
    if (stockOut > stockIn) {
        return alert("Stock Out, Stock In से ज्यादा नहीं हो सकता!");
    }

    const oldItem = editIndex !== "" ? items[Number(editIndex)] : null;

    const item = {
        id: oldItem?.id || makeId(),
        name,
        category,
        date,
        stockIn,
        stockOut,
        buyPrice,
        sellPrice
    };

    try {
        if (cloudReady && auth.currentUser) {
            await saveItemToCloud(item);
            showToast(oldItem ? "Item updated और cloud में save हो गया।" : "Item cloud में save हो गया।");
        } else {
            items[editIndex !== "" ? Number(editIndex) : items.length] = item;
            cacheItems();
            renderTable();
            updateDashboard();
            showToast("Offline: item इस device पर save हुआ।");
        }

        closeModal();
    } catch (error) {
        console.error(error);
        alert("Item save नहीं हुआ। Firebase/Firestore Rules check करें।");
    }
}


/* ================= LOCAL CACHE ================= */

function cacheItems() {
    localStorage.setItem("vegetableItems", JSON.stringify(items));
}

/* ================= CURRENT STOCK ================= */

function getCurrentStock(item) {
    return Math.max(0, Number(item.stockIn) - Number(item.stockOut));
}

function getStockValue(item) {
    return getCurrentStock(item) * Number(item.buyPrice);
}

/* ================= RENDER TABLE ================= */

function renderTable() {
    const table = document.getElementById("inventoryTable");
    if (!table) return;

    const search = document.getElementById("searchInput")?.value.toLowerCase() || "";
    const category = document.getElementById("categoryFilter")?.value || "";

    const filteredItems = items.filter(item => {
        const matchName = String(item.name || "").toLowerCase().includes(search);
        const matchCategory = category === "" || item.category === category;
        return matchName && matchCategory;
    });

    table.innerHTML = "";

    if (filteredItems.length === 0) {
        table.innerHTML = `<tr><td colspan="11">No items found</td></tr>`;
        return;
    }

    filteredItems.forEach((item, filteredIndex) => {
        const originalIndex = items.indexOf(item);
        const currentStock = getCurrentStock(item);
        const value = getStockValue(item);

        table.innerHTML += `
            <tr>
                <td>${originalIndex + 1}</td>
                <td>${formatDate(item.date)}</td>
                <td><strong>${escapeHTML(item.name)}</strong></td>
                <td>${escapeHTML(item.category)}</td>
                <td>${Number(item.stockIn) || 0} KG</td>
                <td>${Number(item.stockOut) || 0} KG</td>
                <td><strong>${currentStock} KG</strong></td>
                <td>₹${Number(item.buyPrice) || 0}</td>
                <td>₹${Number(item.sellPrice) || 0}</td>
                <td>₹${value}</td>
                <td>
                    <button class="edit-btn" onclick="editItem(${originalIndex})">✏️</button>
                    <button class="delete-btn" onclick="deleteItem(${originalIndex})">🗑️</button>
                    <button class="invoice-btn" onclick="addToInvoice(${originalIndex})">🧾 Invoice</button>
                </td>
            </tr>`;
    });
}

/* ================= EDIT ITEM ================= */

function editItem(index) {
    const item = items[index];
    if (!item) return;

    document.getElementById("modalTitle").innerText = "Edit Vegetable";
    document.getElementById("editIndex").value = index;
    document.getElementById("itemName").value = item.name || "";
    document.getElementById("itemCategory").value = item.category || "Vegetable";
    document.getElementById("itemDate").value = item.date || "";
    document.getElementById("stockIn").value = item.stockIn ?? 0;
    document.getElementById("stockOut").value = item.stockOut ?? 0;
    document.getElementById("buyPrice").value = item.buyPrice ?? 0;
    document.getElementById("sellPrice").value = item.sellPrice ?? 0;
    document.getElementById("itemModal").classList.add("show");
}

/* ================= DELETE ITEM ================= */

async function deleteItem(index) {
    const item = items[index];
    if (!item) return;

    if (!confirm(`Delete ${item.name}?`)) return;

    try {
        if (cloudReady && auth.currentUser && item.id) {
            await deleteItemFromCloud(item.id);
            showToast("Item cloud से delete हो गया।");
        } else {
            items.splice(index, 1);
            cacheItems();
            renderTable();
            updateDashboard();
            showToast("Item delete हो गया।");
        }
    } catch (error) {
        console.error(error);
        alert("Delete नहीं हुआ। Firebase/Firestore Rules check करें।");
    }
}

/* ================= DASHBOARD ================= */

function updateDashboard() {
    let totalStock = 0;
    let stockValue = 0;
    const categories = new Set();

    items.forEach(item => {
        totalStock += getCurrentStock(item);
        stockValue += getStockValue(item);
        categories.add(item.category);
    });

    const totalItems = document.getElementById("totalItems");
    const totalStockElement = document.getElementById("totalStock");
    const stockValueElement = document.getElementById("stockValue");
    const totalCategories = document.getElementById("totalCategories");

    if (totalItems) totalItems.innerText = items.length;
    if (totalStockElement) totalStockElement.innerText = totalStock;
    if (stockValueElement) stockValueElement.innerText = stockValue.toLocaleString("en-IN");
    if (totalCategories) totalCategories.innerText = categories.size;
}

/* ================= INVOICE ================= */

function addToInvoice(index) {
    const item = items[index];
    if (!item) return;

    if (getCurrentStock(item) <= 0) {
        return alert("इस item का current stock 0 है।");
    }

    const existing = invoiceItems.find(invoiceItem => invoiceItem.name === item.name);

    if (existing) existing.quantity += 1;
    else invoiceItems.push({
        name: item.name,
        quantity: 1,
        price: Number(item.sellPrice) || 0
    });

    saveInvoice();
    renderInvoice();
    showToast(`${item.name} invoice में add हो गया।`);
    showSection("invoice");
}

function renderInvoice() {
    const table = document.getElementById("invoiceTable");
    if (!table) return;

    table.innerHTML = "";
    let grandTotal = 0;

    if (invoiceItems.length === 0) {
        table.innerHTML = `<tr><td colspan="4">Invoice में अभी कोई item नहीं है।</td></tr>`;
    }

    invoiceItems.forEach((item, index) => {
        const total = Number(item.quantity) * Number(item.price);
        grandTotal += total;

        table.innerHTML += `
            <tr>
                <td>${escapeHTML(item.name)}</td>
                <td>
                    <input type="number" min="1" value="${item.quantity}"
                        onchange="changeInvoiceQty(${index}, this.value)"
                        style="width:80px">
                </td>
                <td>₹${Number(item.price) || 0}</td>
                <td>₹${total}</td>
            </tr>`;
    });

    const invoiceTotal = document.getElementById("invoiceTotal");
    if (invoiceTotal) invoiceTotal.innerText = grandTotal.toLocaleString("en-IN");
}

function changeInvoiceQty(index, quantity) {
    quantity = Number(quantity);

    if (quantity <= 0) invoiceItems.splice(index, 1);
    else invoiceItems[index].quantity = quantity;

    saveInvoice();
    renderInvoice();
}

function saveInvoice() {
    localStorage.setItem("invoiceItems", JSON.stringify(invoiceItems));
}

function printInvoice() {
    if (invoiceItems.length === 0) {
        alert("पहले invoice में item add करें!");
        return;
    }
    window.print();
}

/* ================= HELPERS ================= */

function formatDate(dateString) {
    if (!dateString) return "";
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-IN");
}

function escapeHTML(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function makeId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return "item-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

function setSyncStatus(message, ok) {
    const el = document.getElementById("syncStatus");
    if (!el) return;
    el.textContent = message;
    el.style.background = ok ? "rgba(255,255,255,.14)" : "rgba(180,40,40,.28)";
}

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;

    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

/* Inline onclick in index.html needs module functions exposed globally. */
Object.assign(window, {
    showSection,
    openAddModal,
    closeModal,
    saveItem,
    renderTable,
    editItem,
    deleteItem,
    addToInvoice,
    renderInvoice,
    changeInvoiceQty,
    printInvoice,
    retryCloudSync,
    loginUser,
    logoutUser,
    createManagedUser,
    loadUsers,
    toggleManagedUser,
    removeManagedUser
});
