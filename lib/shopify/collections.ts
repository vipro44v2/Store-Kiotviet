import { shopifyGraphql } from "./graphql";

export interface ShopifyCollection {
  id: string;
  title: string;
  handle: string;
}
export function categoryCollectionHandle(categoryId: number) {
  return `kiotviet-category-${categoryId}`;
}
export async function findShopifyCollectionByHandle(handle: string) {
  const data = await shopifyGraphql<{
    collectionByHandle: ShopifyCollection | null;
  }>(
    `query CollectionByHandle($handle:String!){collectionByHandle(handle:$handle){id title handle}}`,
    { handle },
  );
  return data.collectionByHandle;
}
export async function getShopifyCollection(id: string) {
  const data = await shopifyGraphql<{
    collection: ShopifyCollection | null;
  }>(`query Collection($id:ID!){collection(id:$id){id title handle}}`, { id });
  return data.collection;
}
export async function createShopifyManualCollection(
  title: string,
  handle: string,
) {
  const data = await shopifyGraphql<{
    collectionCreate: {
      collection?: ShopifyCollection;
      userErrors: Array<{ message: string }>;
    };
  }>(
    `mutation CreateKiotVietCollection($collection:CollectionCreateInput!){collectionCreate(collection:$collection){collection{id title handle} userErrors{message}}}`,
    { collection: { title, handle } },
  );
  if (
    data.collectionCreate.userErrors.length ||
    !data.collectionCreate.collection
  )
    throw new Error(
      data.collectionCreate.userErrors
        .map((error) => error.message)
        .join("; ") || "Shopify did not create the collection",
    );
  return data.collectionCreate.collection;
}
export async function updateShopifyCollectionTitle(id: string, title: string) {
  const data = await shopifyGraphql<{
    collectionUpdate: {
      collection?: ShopifyCollection;
      userErrors: Array<{ message: string }>;
    };
  }>(
    `mutation UpdateKiotVietCollection($collection:CollectionUpdateInput!){collectionUpdate(collection:$collection){collection{id title handle} userErrors{message}}}`,
    { collection: { id, title } },
  );
  if (
    data.collectionUpdate.userErrors.length ||
    !data.collectionUpdate.collection
  )
    throw new Error(
      data.collectionUpdate.userErrors
        .map((error) => error.message)
        .join("; ") || "Shopify did not update the collection",
    );
  return data.collectionUpdate.collection;
}

export async function publishShopifyCollectionToOnlineStore(id: string) {
  const publications = await shopifyGraphql<{
    publications: { nodes: Array<{ id: string; name: string }> };
  }>(`query StorefrontPublications{publications(first:100){nodes{id name}}}`);
  const onlineStore = publications.publications.nodes.find(
    (publication) => publication.name.toLowerCase() === "online store",
  );
  if (!onlineStore)
    throw new Error("Shopify Online Store publication was not found");
  const data = await shopifyGraphql<{
    publishablePublish: {
      publishable?: { publishedOnPublication: boolean };
      userErrors: Array<{ message: string }>;
    };
  }>(
    `mutation PublishKiotVietCollection($collectionId:ID!,$publicationId:ID!){publishablePublish(id:$collectionId,input:{publicationId:$publicationId}){publishable{publishedOnPublication(publicationId:$publicationId)} userErrors{message}}}`,
    { collectionId: id, publicationId: onlineStore.id },
  );
  if (
    data.publishablePublish.userErrors.length ||
    !data.publishablePublish.publishable?.publishedOnPublication
  )
    throw new Error(
      data.publishablePublish.userErrors
        .map((error) => error.message)
        .join("; ") || "Shopify did not publish the collection",
    );
}
