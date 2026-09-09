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
let customers = JSON.parse(localStorage.getItem("storeCustomers") || "[]");
let vendors = JSON.parse(localStorage.getItem("storeVendors") || "[]");
let payrollEntries = JSON.parse(localStorage.getItem("payrollEntries") || "[]");
let maintenanceEntries = JSON.parse(localStorage.getItem("maintenanceEntries") || "[]");
let agricultureEntries = JSON.parse(localStorage.getItem("agricultureEntries") || "[]");
let attendanceEntries = JSON.parse(localStorage.getItem("attendanceEntries") || "[]");
let rosterWorkers = JSON.parse(localStorage.getItem("rosterWorkers") || "[]");
let dutyRoster = JSON.parse(localStorage.getItem("dutyRoster") || "{}");
let rosterWeekOffset = 0;
let rosterEditingKey = "";
let managedUsers = [];
let managedUserEditingId = "";
let unsubscribeInventory = null;
let cloudReady = false;
let toastTimer = null;
let currentProfile = null;

/* ================= AUTH + PAGE LOAD ================= */

const ADMIN_LOGIN_ID = "superadmin";
const ADMIN_EMAIL = "superadmin@smartvegetablestore.com";
const ADMIN_PASSWORD = "superadmin@1234";
const INVENTORY_COLLECTION = "vegetableItems";

function profileRole(profile = currentProfile) {
    const role = String(profile?.role || "").trim().toLowerCase();
    const department = String(profile?.department || "").trim().toLowerCase();
    if (["admin", "developer", "superadmin"].includes(role)) return role;
    if (["admin", "developer", "superadmin"].includes(department)) return department;
    return role || "user";
}

function isPrivilegedRole(profile = currentProfile) {
    return ["admin", "developer", "superadmin"].includes(profileRole(profile));
}

function normalizeLoginEmail(value) {
    const email = String(value || "").trim().toLowerCase();
    if (!email) return "";
    if (email === ADMIN_LOGIN_ID) return ADMIN_EMAIL;
    return email;
}

function resolveLoginEmail(value) {
    const normalized = normalizeLoginEmail(value);
    if (!normalized || normalized.includes("@")) return normalized;

    let savedWorkers = rosterWorkers;
    try {
        savedWorkers = JSON.parse(localStorage.getItem("rosterWorkers") || "[]");
    } catch (_) {}
    const worker = [...savedWorkers, ...managedUsers].find(item => {
        const name = String(item.name || "").trim().toLowerCase();
        const userId = String(item.userId || "").trim().toLowerCase();
        return name === normalized || userId === normalized;
    });
    return worker?.email || normalized;
}

function toggleLoginPassword() {
    const passwordInput = document.getElementById("loginPassword");
    const toggleButton = document.querySelector(".password-toggle");
    if (!passwordInput || !toggleButton) return;
    const isHidden = passwordInput.type === "password";
    passwordInput.type = isHidden ? "text" : "password";
    toggleButton.textContent = isHidden ? "Hide" : "Show";
    toggleButton.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
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
    const emailInput = document.getElementById("loginUserId")?.value.trim();
    const password = document.getElementById("loginPassword")?.value || "";
    const email = resolveLoginEmail(emailInput);

    if (!email || !email.includes("@") || !password) {
        return setAuthMessage("Real Email (जैसे akshat@gmail.com) और Password दोनों भरें।", true);
    }

    setAuthMessage("Login हो रहा है...");
    try {
        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (loginError) {
            if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD &&
                ["auth/user-not-found", "auth/invalid-credential"].includes(loginError?.code)) {
                await createUserWithEmailAndPassword(auth, ADMIN_EMAIL, ADMIN_PASSWORD);
            } else {
                throw loginError;
            }
        }
    } catch (error) {
        console.error("Login error:", error);
        const code = error?.code || "";
        let msg = "Login नहीं हुआ। User Management में बनाया गया exact email और password डालें।";
        if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") msg = "Email या Password गलत है। admin@gaml.com और admin@gmail.com अलग-अलग email हैं; वही exact email डालें जो user create करते समय दिया था।";
        if (code === "auth/too-many-requests") msg = "Firebase ने अस्थायी रूप से login रोक दिया है। गलत attempts के बाद कुछ मिनट रुककर exact email/password से फिर try करें।";
        if (code === "auth/user-disabled") msg = "यह Firebase account disabled है। Firebase Authentication में account enable करें।";
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
        const displayName = profile.email || user.email || profile.userId || "User";
        document.getElementById("currentUserLabel").textContent = `${displayName}${profile.role === "superadmin" ? " (Super Admin)" : ""}`;
        const adminBtn = document.getElementById("adminNavBtn");
        if (adminBtn) adminBtn.style.display = isPrivilegedRole(profile) ? "block" : "none";
        const addUserBtn = document.getElementById("addManagedUserBtn");
        if (addUserBtn) addUserBtn.style.display = isPrivilegedRole(profile) ? "inline-block" : "none";

        setTodayDate();
        renderTable();
        updateDashboard();
        renderInvoice();
        await connectCloudInventory();
        if (isPrivilegedRole(profile)) await loadUsers();
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
    renderRoster();
    renderWorkerOptions();
    renderMaintenance();
    renderAgricultureExpenses();
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
    if (!canManageRecords()) {
        throw new Error("Admin permission required");
    }
}

function canManageRecords() {
    return currentProfile?.active === true && isPrivilegedRole();
}

function requireManagePermission() {
    if (!canManageRecords()) {
        alert("केवल Admin या Super Admin edit/delete कर सकते हैं।");
        return false;
    }
    return true;
}

function addOrUpdateRosterWorker(worker) {
    const workerName = String(worker.name || worker.email || "Worker").trim();
    const existing = rosterWorkers.find(item => item.uid === worker.uid || item.email === worker.email || item.name.toLowerCase() === workerName.toLowerCase());
    const rosterWorker = {
        id: existing?.id || worker.id || makeId(),
        uid: worker.uid || existing?.uid || "",
        email: worker.email || existing?.email || "",
        name: workerName,
        role: worker.role || worker.department || existing?.role || "Worker",
        salary: Number(worker.salary || existing?.salary || 0),
        phone: worker.phone || existing?.phone || "",
        createdAt: existing?.createdAt || Date.now()
    };

    if (existing) Object.assign(existing, rosterWorker);
    else rosterWorkers.push(rosterWorker);
    localStorage.setItem("rosterWorkers", JSON.stringify(rosterWorkers));
    renderWorkerOptions();
    renderRoster();
}

function syncUsersToRoster(users) {
    users.filter(user => user.role !== "superadmin" && user.active !== false).forEach(user => {
        addOrUpdateRosterWorker({
            id: user.uid || user.id,
            uid: user.uid || user.id,
            email: user.email,
            name: user.name || user.userId || user.email?.split("@")[0],
            role: user.department || "Worker",
            salary: user.salary || 0
        });
    });
    renderWorkerOptions();
}

function renderWorkerOptions() {
    const options = document.getElementById("workerOptions");
    if (!options) return;
    options.innerHTML = rosterWorkers.map(worker => `<option value="${escapeHTML(worker.name)}">₹${Number(worker.salary || 0).toLocaleString("en-IN")} / month</option>`).join("");
}

function fillWorkerSalary(workerInputId, salaryInputId) {
    const workerName = document.getElementById(workerInputId)?.value.trim().toLowerCase();
    const worker = rosterWorkers.find(item => item.name.toLowerCase() === workerName || item.email?.toLowerCase() === workerName);
    const salaryInput = document.getElementById(salaryInputId);
    if (worker && salaryInput && worker.salary > 0) salaryInput.value = worker.salary;
}

async function createManagedUser() {
    try {
        assertAdmin();
        const name = document.getElementById("newUserName")?.value.trim();
        const email = document.getElementById("newUserEmail")?.value.trim().toLowerCase();
        const role = document.getElementById("newUserRole")?.value.trim() || "Worker";
        const accessRole = document.getElementById("newUserAccessRole")?.value || "user";
        const salary = Number(document.getElementById("newUserSalary")?.value || 0);
        const password = document.getElementById("newUserPassword")?.value || "";

        if (!name) return setAdminMessage("Worker name डालें।", true);
        if (!email || !email.includes("@")) return setAdminMessage("Real email address डालें, जैसे Ashok@gmail.com", true);
        if (!salary || salary <= 0) return setAdminMessage("Monthly salary valid होना चाहिए।", true);

        if (managedUserEditingId) {
            setAdminMessage("User update हो रहा है...");
            const existingUser = managedUsers.find(user => user.id === managedUserEditingId);
            await setDoc(doc(db, "users", managedUserEditingId), {
                name,
                department: role,
                salary,
                role: accessRole,
                updatedAt: Date.now()
            }, { merge: true });
            addOrUpdateRosterWorker({
                id: managedUserEditingId,
                uid: existingUser?.uid || managedUserEditingId,
                email: existingUser?.email || email,
                name,
                role,
                salary
            });
            managedUserEditingId = "";
            closeManagedUserEditor();
            await loadUsers();
            setAdminMessage(`${name} successfully update हो गया।`);
            return;
        }

        if (password.length < 6) return setAdminMessage("Password कम से कम 6 characters का होना चाहिए।", true);

        setAdminMessage("User create हो रहा है...");
        const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        const employeeId = `EMP-${Date.now().toString().slice(-6)}`;
        await setDoc(doc(db, "users", credential.user.uid), {
            uid: credential.user.uid,
            employeeId,
            userId: email.split("@")[0],
            email: credential.user.email,
            name,
            department: role,
            salary,
            role: accessRole,
            active: true,
            createdAt: Date.now(),
            createdBy: auth.currentUser.uid
        });
        addOrUpdateRosterWorker({ id: credential.user.uid, uid: credential.user.uid, name, role, salary, email: credential.user.email });
        await signOut(secondaryAuth);
        document.getElementById("newUserName").value = "";
        document.getElementById("newUserEmail").value = "";
        document.getElementById("newUserRole").value = "";
        document.getElementById("newUserAccessRole").value = "user";
        document.getElementById("newUserSalary").value = "";
        document.getElementById("newUserPassword").value = "";
        closeManagedUserEditor();
        await loadUsers();
        setAdminMessage(`User ${email} successfully create हो गया।`);
    } catch (error) {
        console.error("Create user error:", error);
        let msg = error.message || "User create नहीं हुआ।";
        if (error.code === "auth/email-already-in-use") msg = "यह email पहले से use में है।";
        if (error.code === "auth/weak-password") msg = "Password बहुत weak है।";
        setAdminMessage(msg, true);
        try { await signOut(secondaryAuth); } catch (_) {}
    }
}

async function loadUsers() {
    if (!canManageRecords()) return;
    const list = document.getElementById("usersList");
    if (!list) return;
    try {
        const snap = await getDocs(collection(db, "users"));
                managedUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                syncUsersToRoster(managedUsers);

                renderManagedUsers();
    } catch (error) {
        console.error(error);
        list.innerHTML = "<p>Users load नहीं हुए। Rules check करें।</p>";
    }
}

function renderManagedUsers() {
    const list = document.getElementById("usersList");
    if (!list) return;
    const search = document.getElementById("userSearchInput")?.value.trim().toLowerCase() || "";
    const role = document.getElementById("userRoleFilter")?.value || "";
    const filteredUsers = managedUsers.filter(user => {
        const text = `${user.name || ""} ${user.email || ""} ${user.department || ""} ${user.role || ""}`.toLowerCase();
        return (!search || text.includes(search)) && (!role || user.role === role);
    }).sort((first, second) => (first.name || first.email || "").localeCompare(second.name || second.email || ""));

    const activeCount = managedUsers.filter(user => user.active === true).length;
    document.getElementById("totalUsersCount").textContent = managedUsers.length;
    document.getElementById("activeUsersCount").textContent = activeCount;
    document.getElementById("disabledUsersCount").textContent = managedUsers.length - activeCount;
    document.getElementById("workerUsersCount").textContent = managedUsers.filter(user => user.role !== "superadmin").length;

    if (!filteredUsers.length) {
        list.innerHTML = "<p class=\"users-empty\">No users found.</p>";
        return;
    }

    list.innerHTML = `<div class="users-table-wrap"><table class="users-table">
        <thead><tr><th>User</th><th>Employee ID</th><th>Role / Department</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${filteredUsers.map(user => {
            const name = user.name || user.userId || user.email?.split("@")[0] || "Unknown";
            const employeeId = user.employeeId || `EMP-${String(user.id || "").slice(-6).toUpperCase()}`;
            const department = user.department || (user.role === "superadmin" ? "Administration" : "Worker");
            return `<tr>
                <td><strong>${escapeHTML(name)}</strong><small>${escapeHTML(user.email || "")}</small></td>
                <td class="employee-id">${escapeHTML(employeeId)}</td>
                <td>${escapeHTML(department)}</td>
                <td><span class="user-status ${user.active === true ? "active" : "disabled"}">${user.active === true ? "Active" : "Disabled"}</span></td>
                <td class="user-table-actions">${user.role === "superadmin" ? '<span class="admin-tag">SUPER ADMIN</span>' : (canManageRecords() ? `<button class="small-btn" onclick="editManagedUser('${user.id}')">Edit</button><button class="small-delete" onclick="removeManagedUser('${user.id}')">Delete</button>` : "")}</td>
            </tr>`;
        }).join("")}</tbody>
    </table></div>`;
}

function filterManagedUsers() {
    renderManagedUsers();
}

function openManagedUserEditor() {
    if (!requireManagePermission()) return;
    managedUserEditingId = "";
    document.getElementById("managedUserEditorTitle").textContent = "➕ Create User";
    document.getElementById("managedUserSubmit").textContent = "Create User";
    document.getElementById("newUserName").value = "";
    document.getElementById("newUserEmail").value = "";
    document.getElementById("newUserRole").value = "";
    document.getElementById("newUserAccessRole").value = "user";
    document.getElementById("newUserSalary").value = "";
    document.getElementById("newUserPassword").value = "";
    const editor = document.getElementById("managedUserEditor");
    if (editor) editor.hidden = false;
    document.getElementById("newUserName")?.focus();
}

function editManagedUser(uid) {
    if (!requireManagePermission()) return;
    const user = managedUsers.find(item => item.id === uid);
    if (!user) return;
    managedUserEditingId = uid;
    document.getElementById("managedUserEditorTitle").textContent = "✏️ Edit User";
    document.getElementById("managedUserSubmit").textContent = "Save Changes";
    document.getElementById("newUserName").value = user.name || user.userId || "";
    document.getElementById("newUserEmail").value = user.email || "";
    document.getElementById("newUserRole").value = user.department || "";
    document.getElementById("newUserAccessRole").value = profileRole(user);
    document.getElementById("newUserSalary").value = user.salary || "";
    document.getElementById("newUserPassword").value = "";
    document.getElementById("managedUserEditor").hidden = false;
    document.getElementById("newUserName").focus();
}

function closeManagedUserEditor() {
    const editor = document.getElementById("managedUserEditor");
    if (editor) editor.hidden = true;
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
    const map = { dashboard: 0, inventory: 1, invoice: 2, roster: 3, payroll: 4, maintenance: 5, agriculture: 6, admin: 7 };

    if (navButtons[map[sectionName]]) {
        navButtons[map[sectionName]].classList.add("active");
    }

    if (sectionName === "inventory") renderTable();
    if (sectionName === "invoice") renderInvoice();
    if (sectionName === "roster") renderRoster();
    if (sectionName === "payroll") renderPayroll();
    if (sectionName === "maintenance") renderMaintenance();
    if (sectionName === "agriculture") renderAgricultureExpenses();
    if (sectionName === "admin" && canManageRecords()) loadUsers();

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

    if (editIndex !== "" && !requireManagePermission()) return;
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
                    ${canManageRecords() ? `<button class="edit-btn" onclick="editItem(${originalIndex})">✏️</button>
                    <button class="delete-btn" onclick="deleteItem(${originalIndex})">🗑️</button>` : ""}
                    <button class="invoice-btn" onclick="addToInvoice(${originalIndex})">🧾 Invoice</button>
                </td>
            </tr>`;
    });
}

/* ================= EDIT ITEM ================= */

function editItem(index) {
    if (!requireManagePermission()) return;
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
    if (!requireManagePermission()) return;
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
    const customerCountEl = document.getElementById("customerCount");
    const vendorCountEl = document.getElementById("vendorCount");
    const sellerCountEl = document.getElementById("sellerCount");

    if (totalItems) totalItems.innerText = items.length;
    if (totalStockElement) totalStockElement.innerText = totalStock;
    if (stockValueElement) stockValueElement.innerText = stockValue.toLocaleString("en-IN");
    if (totalCategories) totalCategories.innerText = categories.size;
    if (customerCountEl) customerCountEl.innerText = customers.length;
    if (vendorCountEl) vendorCountEl.innerText = vendors.length;
    if (sellerCountEl) sellerCountEl.innerText = Math.max(1, currentProfile?.role === "superadmin" ? 1 : 0 + (currentProfile ? 1 : 0));
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

function getSellerCount() {
    if (currentProfile?.role === "superadmin") return 1;
    return currentProfile ? 1 : 0;
}

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;

    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function addVendorFromDashboard() {
    const name = document.getElementById("vendorName")?.value.trim();
    const phone = document.getElementById("vendorPhone")?.value.trim();
    const city = document.getElementById("vendorCity")?.value.trim();
    const address = document.getElementById("vendorAddress")?.value.trim();

    if (!name) return alert("Vendor name भरें!");

    vendors.push({
        id: makeId(),
        name,
        phone,
        city,
        address,
        createdAt: Date.now()
    });

    localStorage.setItem("storeVendors", JSON.stringify(vendors));
    updateDashboard();
    showToast("Vendor add हो गया।");

    document.getElementById("vendorName").value = "";
    document.getElementById("vendorPhone").value = "";
    document.getElementById("vendorCity").value = "";
    document.getElementById("vendorAddress").value = "";
}

function rosterDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function getRosterWeekDates() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay() + (rosterWeekOffset * 7));
    return Array.from({ length: 7 }, (_, index) => {
        const date = new Date(weekStart);
        date.setDate(weekStart.getDate() + index);
        return date;
    });
}

function formatRosterDay(date) {
    return `${date.toLocaleDateString("en-IN", { weekday: "short" })}<small>${date.getDate()} ${date.toLocaleDateString("en-IN", { month: "short" })}</small>`;
}

function rosterShiftLabel(shift) {
    if (shift === "Off") return "Day Off";
    if (shift === "Half Day") return "Half Duty (5h)";
    return shift;
}

function rosterShiftClass(shift) {
    const classNames = {
        Morning: "morning",
        Evening: "evening",
        Night: "night",
        "Half Day": "half-day",
        Leave: "leave",
        "Day Off": "day-off",
        Off: "day-off"
    };
    return classNames[shift] || "custom";
}

function rosterDutyWeight(shift) {
    if (["Leave", "Day Off", "Off"].includes(shift)) return 0;
    if (shift === "Half Day") return 0.5;
    return shift ? 1 : 0;
}

function renderRoster() {
    const head = document.getElementById("rosterHead");
    const table = document.getElementById("rosterTable");
    if (!head || !table) return;

    const dates = getRosterWeekDates();
    const dateKeys = dates.map(rosterDateKey);
    const weekStart = dates[0];
    const weekEnd = dates[6];
    const dateRange = `${weekStart.getDate()} ${weekStart.toLocaleDateString("en-IN", { month: "short" })} - ${weekEnd.getDate()} ${weekEnd.toLocaleDateString("en-IN", { month: "short" })}`;
    const weekLabel = document.getElementById("rosterWeekLabel");
    if (weekLabel) weekLabel.textContent = dateRange;

    head.innerHTML = `<tr><th class="roster-staff-heading">Staff</th>${dates.map(date => `<th>${formatRosterDay(date)}</th>`).join("")}</tr>`;

    const scheduledShifts = rosterWorkers.reduce((total, worker) => total + dateKeys.reduce((workerTotal, date) => workerTotal + rosterDutyWeight(dutyRoster[`${worker.id}_${date}`]), 0), 0);
    const workerCount = document.getElementById("rosterWorkerCount");
    const shiftCount = document.getElementById("rosterShiftCount");
    const openCount = document.getElementById("rosterOpenCount");
    if (workerCount) workerCount.textContent = rosterWorkers.length;
    if (shiftCount) shiftCount.textContent = scheduledShifts;
    if (openCount) openCount.textContent = Math.max(0, (rosterWorkers.length * 7) - scheduledShifts).toLocaleString("en-IN");

    if (!rosterWorkers.length) {
        table.innerHTML = `<tr><td colspan="8" class="roster-empty">No workers added yet. Use Add Worker to start the roster.</td></tr>`;
        return;
    }

    table.innerHTML = rosterWorkers.map(worker => `
        <tr>
            <td class="roster-staff-cell">
                <strong>${escapeHTML(worker.name)}</strong>
                <small>${escapeHTML(worker.role || "Worker")}</small>
                ${canManageRecords() ? `<button class="roster-remove-btn" onclick="removeRosterWorker('${worker.id}')">Remove</button>` : ""}
            </td>
            ${dateKeys.map(date => {
                const key = `${worker.id}_${date}`;
                const shift = dutyRoster[key];
                const shiftLabel = rosterShiftLabel(shift);
                const shiftAction = canManageRecords() ? `onclick="editRosterShift('${worker.id}', '${date}')"` : "disabled";
                return `<td><button class="roster-shift ${shift ? `assigned ${rosterShiftClass(shift)}` : "open"}" ${shiftAction}>${shift ? `✦ ${escapeHTML(shiftLabel)}` : "+ Add"}</button></td>`;
            }).join("")}
        </tr>`).join("");
}

function addRosterWorker() {
    const nameInput = document.getElementById("rosterWorkerName");
    const roleInput = document.getElementById("rosterWorkerRole");
    const phoneInput = document.getElementById("rosterWorkerPhone");
    const name = nameInput.value.trim();
    const role = roleInput.value.trim();
    const phone = phoneInput.value.trim();

    if (!name) return alert("Worker name डालें!");
    if (rosterWorkers.some(worker => worker.name.toLowerCase() === name.toLowerCase())) {
        return alert("यह worker पहले से add है!");
    }

    rosterWorkers.push({ id: makeId(), name, role, phone, createdAt: Date.now() });
    localStorage.setItem("rosterWorkers", JSON.stringify(rosterWorkers));
    renderWorkerOptions();
    renderRoster();
    nameInput.value = "";
    roleInput.value = "";
    phoneInput.value = "";
    closeRosterWorkerEditor();
    showToast("Worker roster में add हो गया।");
}

function openRosterWorkerEditor() {
    const editor = document.getElementById("rosterWorkerEditor");
    if (editor) editor.hidden = false;
    document.getElementById("rosterWorkerName")?.focus();
}

function closeRosterWorkerEditor() {
    const editor = document.getElementById("rosterWorkerEditor");
    if (editor) editor.hidden = true;
}

function removeRosterWorker(workerId) {
    if (!requireManagePermission()) return;
    const worker = rosterWorkers.find(item => item.id === workerId);
    if (!worker || !confirm(`${worker.name} को roster से remove करना है?`)) return;
    rosterWorkers = rosterWorkers.filter(item => item.id !== workerId);
    Object.keys(dutyRoster).forEach(key => {
        if (key.startsWith(`${workerId}_`)) delete dutyRoster[key];
    });
    localStorage.setItem("rosterWorkers", JSON.stringify(rosterWorkers));
    localStorage.setItem("dutyRoster", JSON.stringify(dutyRoster));
    renderRoster();
}

function editRosterShift(workerId, date) {
    if (!requireManagePermission()) return;
    const key = `${workerId}_${date}`;
    const currentShift = dutyRoster[key] || "";
    rosterEditingKey = key;
    const editor = document.getElementById("rosterShiftEditor");
    const shiftValue = document.getElementById("rosterShiftValue");
    const editorDate = document.getElementById("rosterShiftEditorDate");
    const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", {
        weekday: "long", day: "numeric", month: "long", year: "numeric"
    });
    if (shiftValue) shiftValue.value = currentShift === "Off" ? "Day Off" : (currentShift || "Morning");
    if (editorDate) editorDate.textContent = `${dateLabel} | Full duty: 10 hours | Half duty: 5 hours`;
    if (editor) editor.hidden = false;
}

function saveRosterShift() {
    if (!requireManagePermission()) return;
    if (!rosterEditingKey) return;
    const shift = document.getElementById("rosterShiftValue")?.value || "Morning";
    dutyRoster[rosterEditingKey] = shift;
    localStorage.setItem("dutyRoster", JSON.stringify(dutyRoster));
    closeRosterShiftEditor();
    renderRoster();
    generateRosterPayroll(false);
    showToast("Duty shift save हो गई।");
}

function removeRosterShift() {
    if (!requireManagePermission()) return;
    if (!rosterEditingKey) return;
    delete dutyRoster[rosterEditingKey];
    localStorage.setItem("dutyRoster", JSON.stringify(dutyRoster));
    closeRosterShiftEditor();
    renderRoster();
    generateRosterPayroll(false);
    showToast("Duty shift remove हो गई।");
}

function closeRosterShiftEditor() {
    rosterEditingKey = "";
    const editor = document.getElementById("rosterShiftEditor");
    if (editor) editor.hidden = true;
}

function changeRosterWeek(direction) {
    rosterWeekOffset += direction;
    renderRoster();
}

function setRosterCurrentWeek() {
    rosterWeekOffset = 0;
    renderRoster();
}

function getAttendanceMonth() {
    const monthInput = document.getElementById("attendanceMonth");
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (monthInput && !monthInput.value) monthInput.value = currentMonth;
    return monthInput?.value || currentMonth;
}

function getDaysInMonth(month) {
    const [year, monthNumber] = month.split("-").map(Number);
    return new Date(year, monthNumber, 0).getDate();
}

function getAttendanceSummaries(month) {
    const records = attendanceEntries.filter(entry => String(entry.date || "").startsWith(month));
    const summaries = new Map();

    records.forEach(entry => {
        const worker = String(entry.worker || "").trim();
        if (!worker) return;
        const key = worker.toLowerCase();
        const summary = summaries.get(key) || {
            worker,
            salary: Number(entry.salary || 0),
            present: 0,
            absent: 0
        };
        summary.salary = Number(entry.salary || summary.salary || 0);
        if (entry.status === "Present") summary.present += 1;
        else summary.absent += 1;
        summaries.set(key, summary);
    });

    const daysInMonth = getDaysInMonth(month);
    return [...summaries.values()].map(summary => ({
        ...summary,
        absent: Math.max(summary.absent, daysInMonth - summary.present),
        payable: Math.round((summary.salary / daysInMonth) * summary.present)
    }));
}

function renderAttendance() {
    const summaryTable = document.getElementById("attendanceSummaryTable");
    const logTable = document.getElementById("attendanceTable");
    if (!summaryTable || !logTable) return;

    const month = getAttendanceMonth();
    const dateInput = document.getElementById("attendanceDate");
    if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().split("T")[0];
    const summaries = getAttendanceSummaries(month);
    const monthRecords = attendanceEntries
        .filter(entry => String(entry.date || "").startsWith(month))
        .sort((first, second) => String(second.date).localeCompare(String(first.date)));

    summaryTable.innerHTML = summaries.length ? summaries.map((summary, index) => `
        <tr>
            <td>${escapeHTML(summary.worker)}</td>
            <td>${summary.present}</td>
            <td>${summary.absent}</td>
            <td>₹${summary.salary.toLocaleString("en-IN")}</td>
            <td><strong>₹${summary.payable.toLocaleString("en-IN")}</strong></td>
            <td><button class="small-btn" onclick="addAttendanceSalaryToPayroll(${index})">Pay Salary</button></td>
        </tr>`).join("") : `<tr><td colspan="6">No attendance marked for this month.</td></tr>`;

    logTable.innerHTML = monthRecords.length ? monthRecords.map(entry => `
        <tr>
            <td>${formatDate(entry.date)}</td>
            <td>${escapeHTML(entry.worker)}</td>
            <td><span class="attendance-status ${entry.status === "Present" ? "present" : "absent"}">${escapeHTML(entry.status)}</span></td>
            <td>₹${Number(entry.salary || 0).toLocaleString("en-IN")}</td>
            <td><button class="small-delete" onclick="deleteAttendance('${entry.id}')">Delete</button></td>
        </tr>`).join("") : `<tr><td colspan="5">No attendance records for this month.</td></tr>`;
}

function saveAttendance() {
    const worker = document.getElementById("attendanceWorker").value.trim();
    const salary = Number(document.getElementById("attendanceSalary").value || 0);
    const date = document.getElementById("attendanceDate").value || new Date().toISOString().split("T")[0];
    const status = document.getElementById("attendanceStatus").value;

    if (!worker) return alert("Worker name डालें!");
    if (!salary || salary <= 0) return alert("Monthly salary valid होना चाहिए!");

    const existing = attendanceEntries.find(entry => String(entry.worker || "").toLowerCase() === worker.toLowerCase() && entry.date === date);
    if (existing) {
        existing.salary = salary;
        existing.status = status;
    } else {
        attendanceEntries.push({ id: makeId(), worker, salary, date, status });
    }

    localStorage.setItem("attendanceEntries", JSON.stringify(attendanceEntries));
    renderAttendance();
    document.getElementById("attendanceWorker").value = "";
    document.getElementById("attendanceSalary").value = "";
    document.getElementById("attendanceDate").value = new Date().toISOString().split("T")[0];
    showToast(existing ? "Attendance update हो गई।" : "Attendance save हो गई।");
}

function markAttendance(status) {
    const statusInput = document.getElementById("attendanceStatus");
    if (statusInput) statusInput.value = status;
    saveAttendance();
}

function deleteAttendance(id) {
    if (!confirm("यह attendance delete करना है?")) return;
    attendanceEntries = attendanceEntries.filter(entry => entry.id !== id);
    localStorage.setItem("attendanceEntries", JSON.stringify(attendanceEntries));
    renderAttendance();
    showToast("Attendance delete हो गई।");
}

function addAttendanceSalaryToPayroll(summaryIndex) {
    const month = getAttendanceMonth();
    const summary = getAttendanceSummaries(month)[summaryIndex];
    if (!summary || summary.payable <= 0) return alert("Payable salary अभी 0 है।");

    payrollEntries.unshift({
        id: makeId(),
        employee: summary.worker,
        type: "Salary",
        amount: summary.payable,
        date: new Date().toISOString().split("T")[0],
        notes: `Attendance salary for ${month}: ${summary.present} present days`
    });
    localStorage.setItem("payrollEntries", JSON.stringify(payrollEntries));
    showToast(`${summary.worker} की salary Payroll में add हो गई।`);
}

function getPayrollMonth() {
    const monthInput = document.getElementById("payrollMonth");
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (monthInput && !monthInput.value) monthInput.value = currentMonth;
    return monthInput?.value || currentMonth;
}

function getRosterPayrollSummaries(month) {
    const [year, monthNumber] = month.split("-").map(Number);
    const daysInMonth = new Date(year, monthNumber, 0).getDate();
    return rosterWorkers.map(worker => {
        const dutyDays = Object.entries(dutyRoster).filter(([key, shift]) => {
            const [workerId, date] = key.split("_");
            return workerId === worker.id && date.startsWith(month);
        }).reduce((total, [, shift]) => total + rosterDutyWeight(shift), 0);
        const monthlySalary = Number(worker.salary || 0);
        return {
            worker,
            dutyDays,
            monthlySalary,
            amount: Math.round((monthlySalary / daysInMonth) * dutyDays)
        };
    }).filter(summary => summary.monthlySalary > 0 || summary.dutyDays > 0);
}

function renderRosterPayroll() {
    const table = document.getElementById("rosterPayrollTable");
    if (!table) return;
    const summaries = getRosterPayrollSummaries(getPayrollMonth());
    table.innerHTML = summaries.length ? summaries.map(summary => `
        <tr>
            <td><strong>${escapeHTML(summary.worker.name)}</strong><small>${escapeHTML(summary.worker.role || "Worker")}</small></td>
            <td>${summary.dutyDays}</td>
            <td>₹${summary.monthlySalary.toLocaleString("en-IN")}</td>
            <td><strong>₹${summary.amount.toLocaleString("en-IN")}</strong></td>
        </tr>`).join("") : `<tr><td colspan="4">No worker salary or roster duty found for this month.</td></tr>`;
}

function generateRosterPayroll(showMessage = true) {
    const month = getPayrollMonth();
    const summaries = getRosterPayrollSummaries(month).filter(summary => summary.amount > 0);
    if (!summaries.length) {
        if (showMessage) alert("इस महीने worker की कोई paid duty या salary नहीं मिली।");
        return;
    }

    summaries.forEach(summary => {
        const note = `Auto salary from Duty Roster: ${summary.dutyDays} duty days in ${month}`;
        const existing = payrollEntries.find(entry => entry.source === "dutyRoster" && entry.sourceWorkerId === summary.worker.id && entry.sourceMonth === month);
        if (existing) {
            existing.amount = summary.amount;
            existing.notes = note;
            existing.date = new Date().toISOString().split("T")[0];
        } else {
            payrollEntries.unshift({
                id: makeId(),
                employee: summary.worker.name,
                type: "Salary",
                amount: summary.amount,
                date: new Date().toISOString().split("T")[0],
                notes: note,
                source: "dutyRoster",
                sourceWorkerId: summary.worker.id,
                sourceMonth: month
            });
        }
    });
    localStorage.setItem("payrollEntries", JSON.stringify(payrollEntries));
    renderPayroll();
    renderRosterPayroll();
    if (showMessage) showToast(`${summaries.length} worker की salary Payroll में generate हो गई।`);
}

function renderPayroll() {
    const table = document.getElementById("payrollTable");
    if (!table) return;

    renderRosterPayroll();

    const salaryPaid = payrollEntries.filter(item => item.type === "Salary" || item.type === "Bonus").reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const cashIn = payrollEntries.filter(item => item.type === "Cash In" || item.type === "Salary" || item.type === "Bonus").reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const advance = payrollEntries.filter(item => item.type === "Advance" || item.type === "Deduction").reduce((sum, item) => sum + Number(item.amount || 0), 0);

    document.getElementById("salaryPaidTotal").innerText = salaryPaid.toLocaleString("en-IN");
    document.getElementById("cashInTotal").innerText = cashIn.toLocaleString("en-IN");
    document.getElementById("advanceTotal").innerText = advance.toLocaleString("en-IN");

    if (!payrollEntries.length) {
        table.innerHTML = `<tr><td colspan="6">No payroll entries yet.</td></tr>`;
        return;
    }

    table.innerHTML = payrollEntries.map((entry, index) => `
        <tr>
            <td>${formatDate(entry.date)}</td>
            <td>${escapeHTML(entry.employee || "-")}</td>
            <td>${escapeHTML(entry.type || "Salary")}</td>
            <td>₹${Number(entry.amount || 0).toLocaleString("en-IN")}</td>
            <td>${escapeHTML(entry.notes || "-")}</td>
            <td>${canManageRecords() ? `<button class="small-delete" onclick="deletePayrollEntry(${index})">Delete</button>` : ""}</td>
        </tr>`).join("");
}

function addPayrollEntry() {
    const employee = document.getElementById("payrollEmployee").value.trim();
    const type = document.getElementById("payrollType").value;
    const amount = Number(document.getElementById("payrollAmount").value || 0);
    const date = document.getElementById("payrollDate").value || new Date().toISOString().split("T")[0];
    const notes = document.getElementById("payrollNotes").value.trim();

    if (!employee) return alert("Employee name डालें!");
    if (!amount || amount <= 0) return alert("Amount valid होना चाहिए!");

    payrollEntries.unshift({
        id: makeId(),
        employee,
        type,
        amount,
        date,
        notes
    });

    localStorage.setItem("payrollEntries", JSON.stringify(payrollEntries));
    renderPayroll();
    document.getElementById("payrollEmployee").value = "";
    document.getElementById("payrollAmount").value = "";
    document.getElementById("payrollNotes").value = "";
    document.getElementById("payrollDate").value = new Date().toISOString().split("T")[0];
    showToast("Payroll entry add हो गया।");
}

function deletePayrollEntry(index) {
    if (!requireManagePermission()) return;
    if (!confirm("यह payroll entry delete करना है?")) return;
    payrollEntries.splice(index, 1);
    localStorage.setItem("payrollEntries", JSON.stringify(payrollEntries));
    renderPayroll();
    showToast("Payroll entry delete हो गया।");
}

function getMaintenanceMonth() {
    const monthInput = document.getElementById("maintenanceMonth");
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (monthInput && !monthInput.value) monthInput.value = currentMonth;
    return monthInput?.value || currentMonth;
}

function renderMaintenance() {
    const table = document.getElementById("maintenanceTable");
    if (!table) return;
    const month = getMaintenanceMonth();
    const monthEntries = maintenanceEntries.filter(entry => String(entry.date || "").startsWith(month));
    const monthTotal = monthEntries.reduce((total, entry) => total + Number(entry.amount || 0), 0);
    const total = maintenanceEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);

    document.getElementById("maintenanceEntryCount").textContent = maintenanceEntries.length;
    document.getElementById("maintenanceMonthTotal").textContent = monthTotal.toLocaleString("en-IN");
    document.getElementById("maintenanceTotal").textContent = total.toLocaleString("en-IN");

    table.innerHTML = monthEntries.length ? monthEntries.map(entry => `
        <tr>
            <td>${formatDate(entry.date)}</td>
            <td><strong>${escapeHTML(entry.title)}</strong></td>
            <td>${escapeHTML(entry.category)}</td>
            <td>${escapeHTML(entry.vendor || "-")}</td>
            <td>₹${Number(entry.amount || 0).toLocaleString("en-IN")}</td>
            <td>${escapeHTML(entry.notes || "-")}</td>
            <td>${canManageRecords() ? `<button class="small-delete" onclick="deleteMaintenanceEntry('${entry.id}')">Delete</button>` : ""}</td>
        </tr>`).join("") : `<tr><td colspan="7">No maintenance entries for this month.</td></tr>`;
}

function addMaintenanceEntry() {
    const title = document.getElementById("maintenanceTitle").value.trim();
    const category = document.getElementById("maintenanceCategory").value;
    const amount = Number(document.getElementById("maintenanceAmount").value || 0);
    const date = document.getElementById("maintenanceDate").value || new Date().toISOString().split("T")[0];
    const vendor = document.getElementById("maintenanceVendor").value.trim();
    const notes = document.getElementById("maintenanceNotes").value.trim();

    if (!title) return alert("Repair item name डालें!");
    if (!amount || amount <= 0) return alert("Amount valid होना चाहिए!");

    maintenanceEntries.unshift({ id: makeId(), title, category, amount, date, vendor, notes });
    localStorage.setItem("maintenanceEntries", JSON.stringify(maintenanceEntries));
    renderMaintenance();
    document.getElementById("maintenanceTitle").value = "";
    document.getElementById("maintenanceAmount").value = "";
    document.getElementById("maintenanceVendor").value = "";
    document.getElementById("maintenanceNotes").value = "";
    document.getElementById("maintenanceDate").value = new Date().toISOString().split("T")[0];
    showToast("Maintenance expense add हो गया।");
}

function deleteMaintenanceEntry(id) {
    if (!requireManagePermission()) return;
    if (!confirm("यह maintenance entry delete करना है?")) return;
    maintenanceEntries = maintenanceEntries.filter(entry => entry.id !== id);
    localStorage.setItem("maintenanceEntries", JSON.stringify(maintenanceEntries));
    renderMaintenance();
    showToast("Maintenance entry delete हो गया।");
}

function getAgricultureMonth() {
    const monthInput = document.getElementById("agricultureMonth");
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (monthInput && !monthInput.value) monthInput.value = currentMonth;
    return monthInput?.value || currentMonth;
}

function renderAgricultureExpenses() {
    const table = document.getElementById("agricultureTable");
    if (!table) return;
    const month = getAgricultureMonth();
    const monthEntries = agricultureEntries.filter(entry => String(entry.date || "").startsWith(month));
    const monthTotal = monthEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    const total = agricultureEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    document.getElementById("agricultureEntryCount").textContent = agricultureEntries.length;
    document.getElementById("agricultureMonthTotal").textContent = monthTotal.toLocaleString("en-IN");
    document.getElementById("agricultureTotal").textContent = total.toLocaleString("en-IN");
    table.innerHTML = monthEntries.length ? monthEntries.map(entry => `
        <tr><td>${formatDate(entry.date)}</td><td><strong>${escapeHTML(entry.title)}</strong></td><td>${escapeHTML(entry.category)}</td><td>${escapeHTML(entry.vendor || "-")}</td><td>₹${Number(entry.amount || 0).toLocaleString("en-IN")}</td><td>${escapeHTML(entry.notes || "-")}</td><td>${canManageRecords() ? `<button class="small-delete" onclick="deleteAgricultureExpense('${entry.id}')">Delete</button>` : ""}</td></tr>`).join("") : `<tr><td colspan="7">No agriculture expenses for this month.</td></tr>`;
}

function addAgricultureExpense() {
    const title = document.getElementById("agricultureTitle").value.trim();
    const category = document.getElementById("agricultureCategory").value;
    const amount = Number(document.getElementById("agricultureAmount").value || 0);
    const date = document.getElementById("agricultureDate").value || new Date().toISOString().split("T")[0];
    const vendor = document.getElementById("agricultureVendor").value.trim();
    const notes = document.getElementById("agricultureNotes").value.trim();
    if (!title) return alert("Expense name डालें!");
    if (!amount || amount <= 0) return alert("Amount valid होना चाहिए!");
    agricultureEntries.unshift({ id: makeId(), title, category, amount, date, vendor, notes });
    localStorage.setItem("agricultureEntries", JSON.stringify(agricultureEntries));
    renderAgricultureExpenses();
    document.getElementById("agricultureTitle").value = "";
    document.getElementById("agricultureAmount").value = "";
    document.getElementById("agricultureVendor").value = "";
    document.getElementById("agricultureNotes").value = "";
    document.getElementById("agricultureDate").value = new Date().toISOString().split("T")[0];
    showToast("Agriculture expense add हो गया।");
}

function deleteAgricultureExpense(id) {
    if (!requireManagePermission()) return;
    if (!confirm("यह agriculture expense delete करना है?")) return;
    agricultureEntries = agricultureEntries.filter(entry => entry.id !== id);
    localStorage.setItem("agricultureEntries", JSON.stringify(agricultureEntries));
    renderAgricultureExpenses();
    showToast("Agriculture expense delete हो गया।");
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
    toggleLoginPassword,
    logoutUser,
    createManagedUser,
    loadUsers,
    renderManagedUsers,
    filterManagedUsers,
    openManagedUserEditor,
    closeManagedUserEditor,
    editManagedUser,
    toggleManagedUser,
    removeManagedUser,
    addVendorFromDashboard,
    renderRoster,
    addRosterWorker,
    openRosterWorkerEditor,
    closeRosterWorkerEditor,
    fillWorkerSalary,
    removeRosterWorker,
    editRosterShift,
    saveRosterShift,
    removeRosterShift,
    closeRosterShiftEditor,
    changeRosterWeek,
    setRosterCurrentWeek,
    saveAttendance,
    markAttendance,
    deleteAttendance,
    addAttendanceSalaryToPayroll,
    renderAttendance,
    addPayrollEntry,
    deletePayrollEntry,
    renderRosterPayroll,
    generateRosterPayroll,
    renderPayroll,
    renderMaintenance,
    addMaintenanceEntry,
    deleteMaintenanceEntry,
    renderAgricultureExpenses,
    addAgricultureExpense,
    deleteAgricultureExpense
});
