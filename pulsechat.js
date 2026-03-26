import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { firebaseConfig, isFirebaseConfigured } from "./pulsechat-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

const authTitle = document.getElementById("authTitle");
const authStatusPill = document.getElementById("authStatusPill");
const signedOutView = document.getElementById("signedOutView");
const signedInView = document.getElementById("signedInView");
const googleSignInBtn = document.getElementById("googleSignInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const authError = document.getElementById("authError");
const accountAvatar = document.getElementById("accountAvatar");
const accountName = document.getElementById("accountName");
const accountEmail = document.getElementById("accountEmail");
const profileForm = document.getElementById("profileForm");
const displayNameInput = document.getElementById("displayNameInput");
const handleInput = document.getElementById("handleInput");
const profileStatus = document.getElementById("profileStatus");
const friendRequestForm = document.getElementById("friendRequestForm");
const friendHandleInput = document.getElementById("friendHandleInput");
const friendRequestStatus = document.getElementById("friendRequestStatus");
const requestCountLabel = document.getElementById("requestCountLabel");
const requestList = document.getElementById("requestList");
const friendCountLabel = document.getElementById("friendCountLabel");
const friendsList = document.getElementById("friendsList");
const chatTitle = document.getElementById("chatTitle");
const chatPresence = document.getElementById("chatPresence");
const chatMessages = document.getElementById("chatMessages");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const sendMessageBtn = document.getElementById("sendMessageBtn");

let currentUser = null;
let currentProfile = null;
let requestsUnsub = null;
let friendsUnsub = null;
let messagesUnsub = null;
let activeConversationId = null;
let activeFriend = null;
let conversationMap = new Map();

disableChat();
setConfigWarningIfNeeded();

googleSignInBtn.addEventListener("click", handleGoogleSignIn);
signOutBtn.addEventListener("click", handleSignOut);
profileForm.addEventListener("submit", handleProfileSave);
friendRequestForm.addEventListener("submit", handleFriendRequest);
messageForm.addEventListener("submit", handleSendMessage);
messageInput.addEventListener("input", autoSizeComposer);

onAuthStateChanged(auth, async (user) => {
  resetRealtimeSubscriptions();
  currentUser = user;

  if (!user) {
    currentProfile = null;
    renderSignedOut();
    renderRequests([]);
    renderFriends([]);
    renderEmptyChat("Sign in and pick a friend", "Once a friend request is accepted, your conversation appears here and updates in real time.");
    return;
  }

  renderSignedIn(user);
  await ensureBaseUserDocument(user);
  await refreshOwnProfile();
  subscribeToRequests();
  subscribeToFriends();
});

async function handleGoogleSignIn() {
  if (!isFirebaseConfigured()) {
    showStatus(authError, "Add your Firebase config in pulsechat-config.js first.", true);
    return;
  }

  hideStatus(authError);
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    showStatus(authError, friendlyError(error), true);
  }
}

async function handleSignOut() {
  await signOut(auth);
}

async function ensureBaseUserDocument(user) {
  const userRef = doc(db, "users", user.uid);
  const snapshot = await getDoc(userRef);
  if (!snapshot.exists()) {
    await setDoc(userRef, {
      uid: user.uid,
      email: user.email || "",
      displayName: user.displayName || "New user",
      handleLower: "",
      handle: "",
      photoURL: user.photoURL || "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } else {
    await updateDoc(userRef, {
      email: user.email || "",
      displayName: user.displayName || snapshot.data().displayName || "User",
      photoURL: user.photoURL || snapshot.data().photoURL || "",
      updatedAt: serverTimestamp()
    });
  }
}

async function refreshOwnProfile() {
  if (!currentUser) {
    return;
  }

  const snapshot = await getDoc(doc(db, "users", currentUser.uid));
  currentProfile = snapshot.exists() ? snapshot.data() : null;
  displayNameInput.value = currentProfile?.displayName || currentUser.displayName || "";
  handleInput.value = currentProfile?.handle || "";
}

async function handleProfileSave(event) {
  event.preventDefault();
  if (!currentUser) {
    showStatus(profileStatus, "Sign in first.", true);
    return;
  }

  const displayName = displayNameInput.value.trim();
  const requestedHandle = normalizeHandle(handleInput.value);

  if (!displayName) {
    showStatus(profileStatus, "Add a display name.", true);
    return;
  }

  if (!requestedHandle) {
    showStatus(profileStatus, "Add a handle using letters, numbers, or underscore.", true);
    return;
  }

  try {
    await runTransaction(db, async (transaction) => {
      const userRef = doc(db, "users", currentUser.uid);
      const userSnap = await transaction.get(userRef);
      const previousHandle = userSnap.data()?.handleLower || "";
      const handleRef = doc(db, "handles", requestedHandle);
      const handleSnap = await transaction.get(handleRef);

      if (handleSnap.exists() && handleSnap.data().uid !== currentUser.uid) {
        throw new Error("That handle is already taken.");
      }

      transaction.set(handleRef, {
        uid: currentUser.uid,
        handle: requestedHandle
      });

      if (previousHandle && previousHandle !== requestedHandle) {
        transaction.delete(doc(db, "handles", previousHandle));
      }

      transaction.set(userRef, {
        uid: currentUser.uid,
        email: currentUser.email || "",
        displayName,
        handle: requestedHandle,
        handleLower: requestedHandle,
        photoURL: currentUser.photoURL || "",
        updatedAt: serverTimestamp()
      }, { merge: true });
    });

    await refreshOwnProfile();
    showStatus(profileStatus, "Profile updated. Friends can now search your handle.");
  } catch (error) {
    showStatus(profileStatus, friendlyError(error), true);
  }
}

async function handleFriendRequest(event) {
  event.preventDefault();
  if (!currentUser || !currentProfile?.handleLower) {
    showStatus(friendRequestStatus, "Save your own handle first so people can add you back.", true);
    return;
  }

  const handleLower = normalizeHandle(friendHandleInput.value);
  if (!handleLower) {
    showStatus(friendRequestStatus, "Enter a valid friend handle.", true);
    return;
  }

  try {
    const targetHandleSnap = await getDoc(doc(db, "handles", handleLower));
    if (!targetHandleSnap.exists()) {
      throw new Error("No user found with that handle.");
    }

    const toUid = targetHandleSnap.data().uid;
    if (toUid === currentUser.uid) {
      throw new Error("You cannot add yourself.");
    }

    const reverseId = friendRequestId(toUid, currentUser.uid);
    const reverseRef = doc(db, "friendRequests", reverseId);
    const reverseSnap = await getDoc(reverseRef);

    if (reverseSnap.exists() && reverseSnap.data().status === "pending") {
      await acceptRequest(reverseId, reverseSnap.data());
      friendRequestForm.reset();
      showStatus(friendRequestStatus, "They had already requested you, so you are now friends.");
      return;
    }

    const requestId = friendRequestId(currentUser.uid, toUid);
    const requestRef = doc(db, "friendRequests", requestId);
    const existingSnap = await getDoc(requestRef);
    if (existingSnap.exists() && existingSnap.data().status === "pending") {
      throw new Error("Friend request already sent.");
    }

    const targetUserSnap = await getDoc(doc(db, "users", toUid));
    if (!targetUserSnap.exists()) {
      throw new Error("That user profile is missing.");
    }

    const conversationId = conversationDocId(currentUser.uid, toUid);
    const conversationSnap = await getDoc(doc(db, "conversations", conversationId));
    if (conversationSnap.exists()) {
      throw new Error("You are already friends.");
    }

    await setDoc(requestRef, {
      fromUid: currentUser.uid,
      toUid,
      status: "pending",
      fromDisplayName: currentProfile.displayName || currentUser.displayName || "User",
      fromHandle: currentProfile.handleLower,
      fromPhotoURL: currentUser.photoURL || "",
      toDisplayName: targetUserSnap.data().displayName || "Friend",
      toHandle: targetUserSnap.data().handleLower || handleLower,
      toPhotoURL: targetUserSnap.data().photoURL || "",
      createdAt: serverTimestamp()
    });

    friendRequestForm.reset();
    showStatus(friendRequestStatus, `Friend request sent to @${handleLower}.`);
  } catch (error) {
    showStatus(friendRequestStatus, friendlyError(error), true);
  }
}

function subscribeToRequests() {
  if (!currentUser) {
    return;
  }

  const requestsQuery = query(
    collection(db, "friendRequests"),
    where("toUid", "==", currentUser.uid),
    where("status", "==", "pending")
  );

  requestsUnsub = onSnapshot(requestsQuery, (snapshot) => {
    const requests = snapshot.docs.map((entry) => ({
      id: entry.id,
      ...entry.data()
    }));
    renderRequests(requests);
  });
}

function subscribeToFriends() {
  if (!currentUser) {
    return;
  }

  const friendsQuery = query(
    collection(db, "conversations"),
    where("participants", "array-contains", currentUser.uid)
  );

  friendsUnsub = onSnapshot(friendsQuery, (snapshot) => {
    const conversations = snapshot.docs.map((entry) => {
      const data = entry.data();
      const friendId = data.participants.find((uid) => uid !== currentUser.uid);
      const friendProfile = data.participantProfiles?.[friendId] || {};
      return {
        id: entry.id,
        friendId,
        friend: friendProfile,
        updatedAt: data.updatedAt?.seconds || 0,
        lastMessage: data.lastMessage || ""
      };
    }).sort((left, right) => right.updatedAt - left.updatedAt);

    conversationMap = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    renderFriends(conversations);

    if (activeConversationId && !conversationMap.has(activeConversationId)) {
      activeConversationId = null;
      activeFriend = null;
      disableChat();
      renderEmptyChat("Select a friend", "Accepted friends appear here and conversations update live.");
    } else if (activeConversationId && conversationMap.has(activeConversationId)) {
      activeFriend = conversationMap.get(activeConversationId).friend;
      renderChatHeader();
    }
  });
}

async function acceptRequest(requestId, requestData) {
  if (!currentUser) {
    return;
  }

  const conversationId = conversationDocId(requestData.fromUid, requestData.toUid);
  const conversationRef = doc(db, "conversations", conversationId);

  await setDoc(conversationRef, {
    participants: [requestData.fromUid, requestData.toUid].sort(),
    participantProfiles: {
      [requestData.fromUid]: {
        uid: requestData.fromUid,
        displayName: requestData.fromDisplayName,
        handle: requestData.fromHandle,
        photoURL: requestData.fromPhotoURL || ""
      },
      [requestData.toUid]: {
        uid: requestData.toUid,
        displayName: currentProfile?.displayName || currentUser.displayName || "You",
        handle: currentProfile?.handleLower || "",
        photoURL: currentUser.photoURL || ""
      }
    },
    lastMessage: "",
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp()
  }, { merge: true });

  await updateDoc(doc(db, "friendRequests", requestId), {
    status: "accepted",
    respondedAt: serverTimestamp()
  });
}

async function declineRequest(requestId) {
  await updateDoc(doc(db, "friendRequests", requestId), {
    status: "declined",
    respondedAt: serverTimestamp()
  });
}

function renderRequests(requests) {
  requestCountLabel.textContent = `${requests.length} pending`;

  if (!requests.length) {
    requestList.innerHTML = `
      <div class="empty-card">
        <strong>No pending requests</strong>
        <p>Friend requests sent to your handle will show up here.</p>
      </div>
    `;
    return;
  }

  requestList.innerHTML = "";
  requests.forEach((request) => {
    const card = document.createElement("article");
    card.className = "request-card";
    card.innerHTML = `
      <div class="request-head">
        <div class="account-card compact-account">
          <img class="avatar" src="${safePhoto(request.fromPhotoURL)}" alt="${escapeHtml(request.fromDisplayName)}">
          <div>
            <strong>${escapeHtml(request.fromDisplayName)}</strong>
            <p class="muted-copy">@${escapeHtml(request.fromHandle)}</p>
          </div>
        </div>
      </div>
      <div class="request-actions">
        <button class="primary-btn accept-btn" type="button">Accept</button>
        <button class="ghost-btn decline-btn" type="button">Decline</button>
      </div>
    `;
    card.querySelector(".accept-btn").addEventListener("click", async () => {
      await acceptRequest(request.id, request);
    });
    card.querySelector(".decline-btn").addEventListener("click", async () => {
      await declineRequest(request.id);
    });
    requestList.appendChild(card);
  });
}

function renderFriends(conversations) {
  friendCountLabel.textContent = `${conversations.length} ${conversations.length === 1 ? "friend" : "friends"}`;

  if (!conversations.length) {
    friendsList.innerHTML = `
      <div class="empty-card">
        <strong>No friends yet</strong>
        <p>Send a handle request and accept one to start chatting.</p>
      </div>
    `;
    return;
  }

  friendsList.innerHTML = "";
  conversations.forEach((conversation) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `friend-card${conversation.id === activeConversationId ? " active" : ""}`;
    button.innerHTML = `
      <div class="friend-card-head">
        <div class="account-card compact-account">
          <img class="avatar" src="${safePhoto(conversation.friend.photoURL)}" alt="${escapeHtml(conversation.friend.displayName || "Friend")}">
          <div>
            <strong>${escapeHtml(conversation.friend.displayName || "Friend")}</strong>
            <p>@${escapeHtml(conversation.friend.handle || "no-handle")}</p>
          </div>
        </div>
      </div>
      <div class="friend-card-meta">
        <small>${escapeHtml(conversation.lastMessage || "No messages yet")}</small>
      </div>
    `;
    button.addEventListener("click", () => openConversation(conversation));
    friendsList.appendChild(button);
  });
}

function openConversation(conversation) {
  activeConversationId = conversation.id;
  activeFriend = conversation.friend;
  enableChat();
  renderChatHeader();
  subscribeToMessages(conversation.id);
  renderFriends(Array.from(conversationMap.values()));
}

function subscribeToMessages(conversationId) {
  if (messagesUnsub) {
    messagesUnsub();
    messagesUnsub = null;
  }

  const messagesQuery = query(
    collection(db, "conversations", conversationId, "messages"),
    orderBy("createdAt", "asc"),
    limit(200)
  );

  messagesUnsub = onSnapshot(messagesQuery, (snapshot) => {
    const messages = snapshot.docs.map((entry) => ({
      id: entry.id,
      ...entry.data()
    }));
    renderMessages(messages);
  });
}

async function handleSendMessage(event) {
  event.preventDefault();
  if (!currentUser || !activeConversationId) {
    return;
  }

  const text = messageInput.value.trim();
  if (!text) {
    return;
  }

  await addDoc(collection(db, "conversations", activeConversationId, "messages"), {
    senderId: currentUser.uid,
    text,
    createdAt: serverTimestamp()
  });

  await updateDoc(doc(db, "conversations", activeConversationId), {
    lastMessage: text,
    updatedAt: serverTimestamp()
  });

  messageInput.value = "";
  autoSizeComposer();
}

function renderMessages(messages) {
  if (!messages.length) {
    renderEmptyChat(`Say hi to ${activeFriend?.displayName || "your friend"}`, "This conversation is live, so new messages appear instantly for both of you.");
    return;
  }

  chatMessages.innerHTML = "";
  messages.forEach((message) => {
    const row = document.createElement("div");
    const isSelf = message.senderId === currentUser?.uid;
    row.className = `message-row ${isSelf ? "self" : "friend"}`;
    row.innerHTML = `
      <article class="message-bubble">
        <p>${escapeHtml(message.text || "")}</p>
        <small>${isSelf ? "You" : escapeHtml(activeFriend?.displayName || "Friend")} • ${formatTimestamp(message.createdAt)}</small>
      </article>
    `;
    chatMessages.appendChild(row);
  });
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderChatHeader() {
  if (!activeFriend) {
    chatTitle.textContent = "Select a friend";
    chatPresence.textContent = "Waiting";
    chatPresence.className = "presence-pill away";
    return;
  }

  chatTitle.textContent = activeFriend.displayName || "Friend";
  chatPresence.textContent = `@${activeFriend.handle || "friend"}`;
  chatPresence.className = "presence-pill online";
}

function renderSignedOut() {
  authTitle.textContent = "Sign in to start";
  authStatusPill.textContent = "Offline";
  authStatusPill.className = "presence-pill away";
  signedOutView.hidden = false;
  signedInView.hidden = true;
  displayNameInput.value = "";
  handleInput.value = "";
  disableChat();
}

function renderSignedIn(user) {
  authTitle.textContent = "Signed in";
  authStatusPill.textContent = "Online";
  authStatusPill.className = "presence-pill online";
  signedOutView.hidden = true;
  signedInView.hidden = false;
  accountAvatar.src = safePhoto(user.photoURL);
  accountName.textContent = user.displayName || "Signed in user";
  accountEmail.textContent = user.email || "";
}

function renderEmptyChat(title, text) {
  chatMessages.innerHTML = `
    <div class="empty-state">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

function disableChat() {
  messageInput.disabled = true;
  sendMessageBtn.disabled = true;
  activeConversationId = null;
  activeFriend = null;
  renderChatHeader();
}

function enableChat() {
  messageInput.disabled = false;
  sendMessageBtn.disabled = false;
  messageInput.placeholder = activeFriend ? `Message ${activeFriend.displayName || "friend"}...` : "Type a message...";
}

function resetRealtimeSubscriptions() {
  requestsUnsub?.();
  friendsUnsub?.();
  messagesUnsub?.();
  requestsUnsub = null;
  friendsUnsub = null;
  messagesUnsub = null;
}

function setConfigWarningIfNeeded() {
  if (!isFirebaseConfigured()) {
    showStatus(authError, "Firebase config is still empty. Fill pulsechat-config.js before sign-in will work.", true);
  }
}

function normalizeHandle(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9_]/g, "").slice(0, 20);
}

function friendRequestId(fromUid, toUid) {
  return `${fromUid}__${toUid}`;
}

function conversationDocId(uidA, uidB) {
  return [uidA, uidB].sort().join("__");
}

function formatTimestamp(timestamp) {
  const date = timestamp?.toDate ? timestamp.toDate() : timestamp?.seconds ? new Date(timestamp.seconds * 1000) : new Date();
  return new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function autoSizeComposer() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
}

function showStatus(element, text, isError = false) {
  element.hidden = false;
  element.textContent = text;
  element.className = `status-text${isError ? " error-text" : " success-text"}`;
}

function hideStatus(element) {
  element.hidden = true;
  element.textContent = "";
}

function friendlyError(error) {
  return error?.message || "Something went wrong. Check your Firebase setup and try again.";
}

function safePhoto(url) {
  return url || "https://placehold.co/80x80/f3ede4/18201b?text=P";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
