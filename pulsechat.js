import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from "./pulsechat-supabase-config.js";

const supabase = isSupabaseConfigured()
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;

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

let currentSession = null;
let currentProfile = null;
let activeFriendship = null;
let activeFriendProfile = null;
let requestsChannel = null;
let friendshipsChannelA = null;
let friendshipsChannelB = null;
let messagesChannel = null;
let friendsCache = [];

disableChat();
setConfigWarningIfNeeded();

googleSignInBtn.addEventListener("click", handleGoogleSignIn);
signOutBtn.addEventListener("click", handleSignOut);
profileForm.addEventListener("submit", handleProfileSave);
friendRequestForm.addEventListener("submit", handleFriendRequest);
messageForm.addEventListener("submit", handleSendMessage);
messageInput.addEventListener("input", autoSizeComposer);

init();

async function init() {
  if (!supabase) {
    renderSignedOut();
    renderRequests([]);
    renderFriends([]);
    renderEmptyChat("Connect Supabase first", "Add your Supabase URL and key, then reload this page.");
    return;
  }

  const { data } = await supabase.auth.getSession();
  await applySession(data.session);

  supabase.auth.onAuthStateChange(async (_event, session) => {
    await applySession(session);
  });
}

async function applySession(session) {
  resetRealtimeSubscriptions();
  currentSession = session;
  currentProfile = null;
  activeFriendship = null;
  activeFriendProfile = null;
  friendsCache = [];

  if (!session?.user) {
    renderSignedOut();
    renderRequests([]);
    renderFriends([]);
    renderEmptyChat("Sign in and pick a friend", "Once a friend request is accepted, your conversation appears here and updates in real time.");
    return;
  }

  renderSignedIn(session.user);
  await ensureProfile(session.user);
  await refreshOwnProfile();
  await refreshRequests();
  await refreshFriendships();
  subscribeToRequests();
  subscribeToFriendships();
}

async function handleGoogleSignIn() {
  if (!supabase) {
    showStatus(authError, "Add your Supabase config first.", true);
    return;
  }

  hideStatus(authError);
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin + window.location.pathname
    }
  });

  if (error) {
    showStatus(authError, friendlyError(error), true);
  }
}

async function handleSignOut() {
  if (!supabase) {
    return;
  }

  await supabase.auth.signOut();
}

async function ensureProfile(user) {
  const baseProfile = {
    id: user.id,
    email: user.email || "",
    display_name: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split("@")[0] || "New user",
    avatar_url: user.user_metadata?.avatar_url || "",
    updated_at: new Date().toISOString()
  };

  const { data: existing } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (!existing) {
    await supabase.from("profiles").insert({
      ...baseProfile,
      handle: "",
      handle_lower: "",
      created_at: new Date().toISOString()
    });
  } else {
    await supabase
      .from("profiles")
      .update({
        email: baseProfile.email,
        display_name: existing.display_name || baseProfile.display_name,
        avatar_url: existing.avatar_url || baseProfile.avatar_url,
        updated_at: new Date().toISOString()
      })
      .eq("id", user.id);
  }
}

async function refreshOwnProfile() {
  const user = currentSession?.user;
  if (!user) {
    return;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error) {
    showStatus(authError, friendlyError(error), true);
    return;
  }

  currentProfile = data;
  displayNameInput.value = currentProfile.display_name || "";
  handleInput.value = currentProfile.handle || "";
}

async function handleProfileSave(event) {
  event.preventDefault();
  if (!currentSession?.user) {
    showStatus(profileStatus, "Sign in first.", true);
    return;
  }

  const displayName = displayNameInput.value.trim();
  const handleLower = normalizeHandle(handleInput.value);

  if (!displayName) {
    showStatus(profileStatus, "Add a display name.", true);
    return;
  }

  if (!handleLower) {
    showStatus(profileStatus, "Add a handle using letters, numbers, or underscore.", true);
    return;
  }

  const { data: existingHandle } = await supabase
    .from("profiles")
    .select("id")
    .eq("handle_lower", handleLower)
    .neq("id", currentSession.user.id)
    .maybeSingle();

  if (existingHandle) {
    showStatus(profileStatus, "That handle is already taken.", true);
    return;
  }

  const { error } = await supabase
    .from("profiles")
    .update({
      display_name: displayName,
      handle: handleLower,
      handle_lower: handleLower,
      updated_at: new Date().toISOString()
    })
    .eq("id", currentSession.user.id);

  if (error) {
    showStatus(profileStatus, friendlyError(error), true);
    return;
  }

  await refreshOwnProfile();
  showStatus(profileStatus, "Profile updated. Friends can now search your handle.");
}

async function handleFriendRequest(event) {
  event.preventDefault();
  if (!currentSession?.user || !currentProfile?.handle_lower) {
    showStatus(friendRequestStatus, "Save your own handle first.", true);
    return;
  }

  const targetHandle = normalizeHandle(friendHandleInput.value);
  if (!targetHandle) {
    showStatus(friendRequestStatus, "Enter a valid friend handle.", true);
    return;
  }

  const { data: targetProfile, error: targetError } = await supabase
    .from("profiles")
    .select("*")
    .eq("handle_lower", targetHandle)
    .maybeSingle();

  if (targetError || !targetProfile) {
    showStatus(friendRequestStatus, "No user found with that handle.", true);
    return;
  }

  if (targetProfile.id === currentSession.user.id) {
    showStatus(friendRequestStatus, "You cannot add yourself.", true);
    return;
  }

  const [userA, userB] = normalizePair(currentSession.user.id, targetProfile.id);
  const { data: existingFriendship } = await supabase
    .from("friendships")
    .select("id")
    .eq("user_a", userA)
    .eq("user_b", userB)
    .maybeSingle();

  if (existingFriendship) {
    showStatus(friendRequestStatus, "You are already friends.", true);
    return;
  }

  const { data: reverseRequest } = await supabase
    .from("friend_requests")
    .select("*")
    .eq("from_user", targetProfile.id)
    .eq("to_user", currentSession.user.id)
    .eq("status", "pending")
    .maybeSingle();

  if (reverseRequest) {
    await acceptRequest(reverseRequest.id, reverseRequest.from_user, reverseRequest.to_user);
    friendRequestForm.reset();
    showStatus(friendRequestStatus, "They had already requested you, so you are now friends.");
    return;
  }

  const { data: existingRequest } = await supabase
    .from("friend_requests")
    .select("id")
    .eq("from_user", currentSession.user.id)
    .eq("to_user", targetProfile.id)
    .eq("status", "pending")
    .maybeSingle();

  if (existingRequest) {
    showStatus(friendRequestStatus, "Friend request already sent.", true);
    return;
  }

  const { error } = await supabase.from("friend_requests").insert({
    from_user: currentSession.user.id,
    to_user: targetProfile.id,
    status: "pending"
  });

  if (error) {
    showStatus(friendRequestStatus, friendlyError(error), true);
    return;
  }

  friendRequestForm.reset();
  showStatus(friendRequestStatus, `Friend request sent to @${targetHandle}.`);
}

async function refreshRequests() {
  const user = currentSession?.user;
  if (!user) {
    renderRequests([]);
    return;
  }

  const { data: requests, error } = await supabase
    .from("friend_requests")
    .select("*")
    .eq("to_user", user.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) {
    renderRequests([]);
    return;
  }

  if (!requests.length) {
    renderRequests([]);
    return;
  }

  const senderIds = requests.map((request) => request.from_user);
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name, handle, avatar_url")
    .in("id", senderIds);

  const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));
  renderRequests(requests.map((request) => ({
    ...request,
    fromProfile: profileMap.get(request.from_user)
  })));
}

async function refreshFriendships() {
  const user = currentSession?.user;
  if (!user) {
    renderFriends([]);
    return;
  }

  const [{ data: fromA }, { data: fromB }] = await Promise.all([
    supabase.from("friendships").select("*").eq("user_a", user.id),
    supabase.from("friendships").select("*").eq("user_b", user.id)
  ]);

  const friendships = [...(fromA || []), ...(fromB || [])].sort((left, right) =>
    new Date(right.updated_at || 0) - new Date(left.updated_at || 0)
  );

  if (!friendships.length) {
    friendsCache = [];
    renderFriends([]);
    return;
  }

  const friendIds = friendships.map((friendship) =>
    friendship.user_a === user.id ? friendship.user_b : friendship.user_a
  );

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name, handle, avatar_url")
    .in("id", friendIds);

  const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));
  friendsCache = friendships.map((friendship) => {
    const friendId = friendship.user_a === user.id ? friendship.user_b : friendship.user_a;
    return {
      ...friendship,
      friendProfile: profileMap.get(friendId)
    };
  });

  renderFriends(friendsCache);

  if (activeFriendship) {
    const refreshed = friendsCache.find((entry) => entry.id === activeFriendship.id);
    if (refreshed) {
      activeFriendship = refreshed;
      activeFriendProfile = refreshed.friendProfile;
      renderChatHeader();
    }
  }
}

async function acceptRequest(requestId, fromUser, toUser) {
  const [userA, userB] = normalizePair(fromUser, toUser);

  const { error: friendshipError } = await supabase
    .from("friendships")
    .upsert({
      user_a: userA,
      user_b: userB,
      last_message: "",
      updated_at: new Date().toISOString()
    }, { onConflict: "user_a,user_b" });

  if (friendshipError) {
    showStatus(friendRequestStatus, friendlyError(friendshipError), true);
    return;
  }

  await supabase
    .from("friend_requests")
    .update({ status: "accepted", responded_at: new Date().toISOString() })
    .eq("id", requestId);

  await refreshRequests();
  await refreshFriendships();
}

async function declineRequest(requestId) {
  await supabase
    .from("friend_requests")
    .update({ status: "declined", responded_at: new Date().toISOString() })
    .eq("id", requestId);
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
    const profile = request.fromProfile || {};
    const card = document.createElement("article");
    card.className = "request-card";
    card.innerHTML = `
      <div class="account-card compact-account">
        <img class="avatar" src="${safePhoto(profile.avatar_url)}" alt="${escapeHtml(profile.display_name || "Friend")}">
        <div>
          <strong>${escapeHtml(profile.display_name || "Friend")}</strong>
          <p class="muted-copy">@${escapeHtml(profile.handle || "no-handle")}</p>
        </div>
      </div>
      <div class="request-actions">
        <button class="primary-btn accept-btn" type="button">Accept</button>
        <button class="ghost-btn decline-btn" type="button">Decline</button>
      </div>
    `;
    card.querySelector(".accept-btn").addEventListener("click", () => acceptRequest(request.id, request.from_user, request.to_user));
    card.querySelector(".decline-btn").addEventListener("click", () => declineRequest(request.id));
    requestList.appendChild(card);
  });
}

function renderFriends(friends) {
  friendCountLabel.textContent = `${friends.length} ${friends.length === 1 ? "friend" : "friends"}`;

  if (!friends.length) {
    friendsList.innerHTML = `
      <div class="empty-card">
        <strong>No friends yet</strong>
        <p>Send a handle request and accept one to start chatting.</p>
      </div>
    `;
    return;
  }

  friendsList.innerHTML = "";
  friends.forEach((friendship) => {
    const friend = friendship.friendProfile || {};
    const button = document.createElement("button");
    button.type = "button";
    button.className = `friend-card${friendship.id === activeFriendship?.id ? " active" : ""}`;
    button.innerHTML = `
      <div class="friend-card-head">
        <div class="account-card compact-account">
          <img class="avatar" src="${safePhoto(friend.avatar_url)}" alt="${escapeHtml(friend.display_name || "Friend")}">
          <div>
            <strong>${escapeHtml(friend.display_name || "Friend")}</strong>
            <p>@${escapeHtml(friend.handle || "no-handle")}</p>
          </div>
        </div>
      </div>
      <div class="friend-card-meta">
        <small>${escapeHtml(friendship.last_message || "No messages yet")}</small>
      </div>
    `;
    button.addEventListener("click", () => openConversation(friendship));
    friendsList.appendChild(button);
  });
}

async function openConversation(friendship) {
  activeFriendship = friendship;
  activeFriendProfile = friendship.friendProfile;
  enableChat();
  renderChatHeader();
  await refreshMessages();
  subscribeToMessages();
  renderFriends(friendsCache);
}

async function refreshMessages() {
  if (!activeFriendship) {
    return;
  }

  const { data: messages } = await supabase
    .from("messages")
    .select("*")
    .eq("friendship_id", activeFriendship.id)
    .order("created_at", { ascending: true })
    .limit(200);

  renderMessages(messages || []);
}

async function handleSendMessage(event) {
  event.preventDefault();
  if (!currentSession?.user || !activeFriendship) {
    return;
  }

  const body = messageInput.value.trim();
  if (!body) {
    return;
  }

  const timestamp = new Date().toISOString();
  const { error } = await supabase.from("messages").insert({
    friendship_id: activeFriendship.id,
    sender_id: currentSession.user.id,
    body,
    created_at: timestamp
  });

  if (error) {
    showStatus(friendRequestStatus, friendlyError(error), true);
    return;
  }

  await supabase
    .from("friendships")
    .update({
      last_message: body,
      updated_at: timestamp
    })
    .eq("id", activeFriendship.id);

  messageInput.value = "";
  autoSizeComposer();
}

function renderMessages(messages) {
  if (!messages.length) {
    renderEmptyChat(`Say hi to ${activeFriendProfile?.display_name || "your friend"}`, "This conversation is live, so new messages appear instantly for both of you.");
    return;
  }

  chatMessages.innerHTML = "";
  messages.forEach((message) => {
    const isSelf = message.sender_id === currentSession?.user?.id;
    const row = document.createElement("div");
    row.className = `message-row ${isSelf ? "self" : "friend"}`;
    row.innerHTML = `
      <article class="message-bubble">
        <p>${escapeHtml(message.body || "")}</p>
        <small>${isSelf ? "You" : escapeHtml(activeFriendProfile?.display_name || "Friend")} • ${formatTimestamp(message.created_at)}</small>
      </article>
    `;
    chatMessages.appendChild(row);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderChatHeader() {
  if (!activeFriendProfile) {
    chatTitle.textContent = "Select a friend";
    chatPresence.textContent = "Waiting";
    chatPresence.className = "presence-pill away";
    return;
  }

  chatTitle.textContent = activeFriendProfile.display_name || "Friend";
  chatPresence.textContent = `@${activeFriendProfile.handle || "friend"}`;
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
  accountAvatar.src = safePhoto(user.user_metadata?.avatar_url);
  accountName.textContent = user.user_metadata?.full_name || user.user_metadata?.name || user.email || "Signed in user";
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
  activeFriendship = null;
  activeFriendProfile = null;
  renderChatHeader();
}

function enableChat() {
  messageInput.disabled = false;
  sendMessageBtn.disabled = false;
  messageInput.placeholder = activeFriendProfile ? `Message ${activeFriendProfile.display_name || "friend"}...` : "Type a message...";
}

function subscribeToRequests() {
  const userId = currentSession?.user?.id;
  if (!userId) {
    return;
  }

  requestsChannel = supabase
    .channel(`friend_requests:${userId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "friend_requests",
      filter: `to_user=eq.${userId}`
    }, () => {
      refreshRequests();
    })
    .subscribe();
}

function subscribeToFriendships() {
  const userId = currentSession?.user?.id;
  if (!userId) {
    return;
  }

  friendshipsChannelA = supabase
    .channel(`friendships_a:${userId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "friendships",
      filter: `user_a=eq.${userId}`
    }, () => {
      refreshFriendships();
    })
    .subscribe();

  friendshipsChannelB = supabase
    .channel(`friendships_b:${userId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "friendships",
      filter: `user_b=eq.${userId}`
    }, () => {
      refreshFriendships();
    })
    .subscribe();
}

function subscribeToMessages() {
  if (!activeFriendship) {
    return;
  }

  if (messagesChannel) {
    supabase.removeChannel(messagesChannel);
    messagesChannel = null;
  }

  messagesChannel = supabase
    .channel(`messages:${activeFriendship.id}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "messages",
      filter: `friendship_id=eq.${activeFriendship.id}`
    }, () => {
      refreshMessages();
    })
    .subscribe();
}

function resetRealtimeSubscriptions() {
  if (!supabase) {
    return;
  }

  if (requestsChannel) supabase.removeChannel(requestsChannel);
  if (friendshipsChannelA) supabase.removeChannel(friendshipsChannelA);
  if (friendshipsChannelB) supabase.removeChannel(friendshipsChannelB);
  if (messagesChannel) supabase.removeChannel(messagesChannel);
  requestsChannel = null;
  friendshipsChannelA = null;
  friendshipsChannelB = null;
  messagesChannel = null;
}

function setConfigWarningIfNeeded() {
  if (!isSupabaseConfigured()) {
    showStatus(authError, "Supabase config is still empty. Fill pulsechat-supabase-config.js before sign-in will work.", true);
  }
}

function normalizeHandle(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9_]/g, "").slice(0, 20);
}

function normalizePair(a, b) {
  return [a, b].sort();
}

function formatTimestamp(value) {
  const date = value ? new Date(value) : new Date();
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
  return error?.message || "Something went wrong. Check your Supabase setup and try again.";
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
