import { Address, Bundle, BundleEntry, BundleLink, CodeableConcept, Coding, ContactPoint, UsageContext, ValueSet } from "fhir/r4";
import EasyTableDefinition from '~/models/EasyTableDefinition'
import axios, { AxiosResponse } from "axios";
import { AxiosError } from "axios";
import { ConformanceResourceData, WithPublishingHistory } from "~/models/ConformanceResourceTableData";
import { ConformanceResourceInterface } from "~/models/ConformanceResourceInterface";
import { urlencoded } from "express";
import { BaseResourceData } from "~/models/BaseResourceTableData";
import { settings } from "./user_settings";

export const requestFhirAcceptHeaders = "application/fhir+json; fhirVersion=4.0, application/fhir+json";
export const requestFhirContentTypeHeaders = "application/fhir+json";

export function getLink(
  type: "first" | "previous" | "next" | "last",
  links: BundleLink[] | undefined
): string | undefined {
  if (!links) return undefined;
  for (let linkVal of links) {
    if (linkVal.relation === type) {
      return linkVal.url;
    }
  }
  return undefined;
}

/** Perform a FHIR Search operation */
export async function searchPage<T>(host: EasyTableDefinition<T>, url: string, mapData: (entries: BundleEntry[]) => void) {
  try {
    if (host.cancelSource) host.cancelSource.cancel("new search started");
    host.cancelSource = axios.CancelToken.source();
    host.loadingData = true;
    let token = host.cancelSource.token;
    const response = await axios.get<Bundle>(url, {
      cancelToken: token,
      headers: { "Accept": requestFhirAcceptHeaders }
    });
    if (token.reason) {
      console.log(token.reason);
      return;
    }
    host.cancelSource = undefined;
    host.loadingData = false;

    const results = response.data.entry;
    if (results) {
      host.totalCount = response.data.total;
      if (response.data.link) {
        host.firstPageLink = getLink("first", response.data.link);
        host.previousPageLink = getLink("previous", response.data.link);
        host.nextPageLink = getLink("next", response.data.link);
        host.lastPageLink = getLink("last", response.data.link);
      }

      mapData(results);
      host.showEmpty = false;

    } else {
      host.tableData = [];
      host.showEmpty = true;
    }
  } catch (err) {
    host.loadingData = false;
    host.showEmpty = true;
    host.tableData = [];
    if (axios.isAxiosError(err)) {
      const serverError = err as AxiosError<fhir4.OperationOutcome>;
      if (serverError && serverError.response) {
        return serverError.response.data;
      }
    } else {
      console.log("Client Error:", err);
    }
  }
}

export function calculateNextVersion(versions: (string | undefined)[]): string {
  // TODO: Perform a calculation of the next version number
  return "";
}

export async function loadPublishedVersions<TData extends ConformanceResourceInterface>(serverBaseUrl: string, resourceType: string, canonicalUrl: string, data: WithPublishingHistory<TData>) {
  try {
    const urlRequest = `${serverBaseUrl}/${resourceType}?url=${canonicalUrl}&_summary=true`;
    const response = await axios.get<Bundle>(urlRequest,
      {
        // query URL without using browser cache
        headers: {
          'Cache-Control': 'no-cache',
          "Accept": requestFhirAcceptHeaders
        },
      });
    var result: TData[] = [];
    if (response?.data?.entry) {
      for (var entry of response.data.entry) {
        if (entry.resource?.resourceType === resourceType) {
          result.push(entry.resource as TData);
        }
      }
    }
    data.publishedVersions = result;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const serverError = err as AxiosError<fhir4.OperationOutcome>;
      if (serverError && serverError.response) {
        return serverError.response.data;
      }
    } else {
      console.log("Client Error:", err);
    }
  }
}

export async function loadFhirResource<TData extends fhir4.FhirResource>(serverBaseUrl: string, data: BaseResourceData<TData>, resourceType: string, routeId: string, createNew: () => TData) {
  try {
    // clear the save validation messaging properties
    data.showOutcome = false;
    data.saveOutcome = undefined;
    data.showAdvancedSettings = settings.showAdvancedSettings();

    if (routeId === ":new") {
      data.raw = createNew();
      data.enableSave = true;
      return;
    }

    var loadResourceId = routeId;
    if (loadResourceId.endsWith(":new")) {
      data.enableSave = true;
      loadResourceId = loadResourceId.substring(
        0,
        loadResourceId.lastIndexOf(":")
      );
    }

    const urlRequest = `${serverBaseUrl}/${resourceType}/${loadResourceId}`;
    const response = await axios.get<TData>(urlRequest, {
      // query URL without using browser cache
      headers: {
        "Cache-Control": "no-cache",
        "Accept": requestFhirAcceptHeaders
      },
    });
    data.raw = response.data;

    if (routeId.endsWith(":new")) {
      console.log("new draft version");
      delete data.raw.id;
      if (data.raw.meta) {
        delete data.raw.meta.lastUpdated;
        delete data.raw.meta.versionId;
      }
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const serverError = err as AxiosError<fhir4.OperationOutcome>;
      if (serverError && serverError.response) {
        return serverError.response.data;
      }
    } else {
      console.log("Client Error:", err);
    }
  }
}

export async function loadCanonicalResource<TData extends fhir4.FhirResource, CData extends ConformanceResourceInterface>(serverBaseUrl: string, data: BaseResourceData<TData>, cdata: ConformanceResourceData<CData>, resourceType: string, routeId: string, createNew: () => TData) {
  await loadFhirResource(serverBaseUrl, data, resourceType, routeId, createNew);
  var loadedResource = data.raw as ConformanceResourceInterface;
  if (loadedResource) {
    if (loadedResource.text?.status === "generated") delete loadedResource.text;

    if (routeId.endsWith(":new") && routeId !== ":new") {
      loadedResource.status = "draft";
      delete loadedResource.date;
    }

    // now that we have the URL for the instance - check for other published versions
    if (loadedResource.url) {
      const lastVersion = loadedResource.version;
      await loadPublishedVersions<CData>(
        serverBaseUrl,
        resourceType,
        loadedResource.url,
        cdata
      );

      if (routeId.endsWith(":new") && routeId !== ":new") {
        // inject this as the newest published version (even though it's not saved)
        if (cdata.raw)
          cdata.publishedVersions?.splice(0, 0, cdata.raw);

        // and update the canonical version
        loadedResource.version = calculateNextVersion(
          cdata.publishedVersions?.map<string | undefined>((pv) => {
            return pv.version;
          }) ?? []
        );
      }
    }
  }
}

export async function saveFhirResource<TData extends fhir4.FhirResource>(serverBaseUrl: string, data: BaseResourceData<TData>): Promise<fhir4.OperationOutcome | undefined> {
  data.saving = true;
  try {
    const resource = data.raw as fhir4.FhirResource;
    console.log("save " + data.raw?.id);
    data.showOutcome = undefined;
    data.saveOutcome = undefined;

    var response: AxiosResponse<TData, any>;
    if (data.raw?.id) {
      const urlRequest = `${serverBaseUrl}/${data.raw?.resourceType}/${data.raw.id}`;
      response = await axios.put<TData>(urlRequest, data.raw, { headers: { "Accept": requestFhirAcceptHeaders } });
    } else {
      // Create a new resource (via post)
      const urlRequest = `${serverBaseUrl}/${data.raw?.resourceType}`;
      response = await axios.post<TData>(urlRequest, data.raw, { headers: { "Accept": requestFhirAcceptHeaders } });
    }
    data.raw = response.data;
    data.saving = false;
    data.enableSave = false;
  } catch (err) {
    data.saving = false;
    if (axios.isAxiosError(err)) {
      const serverError = err as AxiosError<fhir4.OperationOutcome>;
      if (serverError && serverError.response) {
        data.saveOutcome = serverError.response.data;
        data.showOutcome = true;
        return serverError.response.data;
      }
    } else {
      console.log("Client Error:", err);
    }
  }
}

export async function expandValueSet(serverBaseUrl: string, vsCanonical: string, filter?: string): Promise<fhir4.ValueSetExpansion | fhir4.OperationOutcome> {
  const can = splitCanonical(vsCanonical);
  let urlRequest = `${serverBaseUrl}/ValueSet/$expand?url=${can?.canonicalUrl}`;
  if (can?.version){
    urlRequest += `&version=${encodeURI(can.version)}`;
  }
  if (filter && filter.length > 0) {
    urlRequest += `&filter=${encodeURI(filter)}`;
  }
  try {
    const response = await axios.get<fhir4.ValueSet | fhir4.OperationOutcome>(urlRequest, {
      // query URL without using browser cache
      headers: {
        "Cache-Control": "no-cache",
        "Accept": requestFhirAcceptHeaders
      },
    });
    if (response.data.resourceType === 'OperationOutcome')
      return response.data;
    let vsResult = response.data as fhir4.ValueSet;
    if (vsResult.expansion)
      return vsResult.expansion;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const serverError = err as AxiosError<fhir4.OperationOutcome>;
      if (serverError && serverError.response) {
        return serverError.response.data;
      }
    } else {
      console.log("Client Error:", err);
      return {
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'informational',
            diagnostics: 'Terminology Server failed to return an expansion in the Valueset returned: ' + err,
            details: {text: '(none)'}
          }
        ]
      };
        }
  }
  return {
    resourceType: 'OperationOutcome',
    issue: [
      {
        severity: 'error',
        code: 'informational',
        diagnostics: 'Terminology Server failed to return an expansion in the Valueset returned.',
        details: {text: '(none)'}
      }
    ]
  };
}

export const searchPublishingStatuses = [
  "active,draft",
  "active",
  "draft",
  "retired",
];

export function toSearchDisplay_UseContext(data: UsageContext[] | undefined): string | undefined {
  var result = "";
  if (data) {
    for (var item of data) {
      if (item.valueCodeableConcept) {
        if (result) result += ', ';
        result += toSearchDisplay_CodeableConcept([item.valueCodeableConcept]);
      }
    }
  }
  return result;
}

export function toSearchDisplay_CodeableConcept(data: CodeableConcept[] | undefined): string | undefined {
  var result = "";
  if (data) {
    for (var item of data) {
      if (item.text) {
        if (result) result += ', ';
        result += item.text;
      } else {
        if (item.coding) {
          var t = toSearchDisplay_Coding(item.coding);
          if (t) {
            if (result) result += ', ';
            result += t;
          }
        }
      }
    }
  }
  return result;
}

export function toSearchDisplay_Coding(data: Coding[] | undefined): string | undefined {
  var result = "";
  if (data) {
    for (var coding of data) {
      if (coding.display || coding.code) {
        if (result) result += ', ';
        result += coding.display ?? coding.code;
      }
    }
  }
  return result;
}

export function toSearchDisplay_Address(data: Address[] | undefined): string | undefined {
  var result = "";
  if (data) {
    for (var addr of data) {
      if (addr.text) {
        if (result) result += ', ';
        result += addr.text;
      } else {
        // Need to grab the components of the address
        var parts: string[] = [];
        if (addr.line) parts.push(...addr.line);
        if (addr.city) parts.push(addr.city);
        if (addr.state) parts.push(addr.state);
        if (addr.postalCode) parts.push(addr.postalCode);
        if (addr.country) parts.push(addr.country);

        if (result) result += ';  ';
        result += parts.join(", ");
      }
    }
  }
  return result;
}

export function toSearchDisplay_Telecom(data: ContactPoint[] | undefined): string | undefined {
  var result = "";
  if (data) {
    for (var cp of data) {
      if (result) result += ', ';
      result += `${cp.system}: ${cp.value}`;
    }
  }
  return result;
}

interface VersionedCanonicalUrl {
  canonicalUrl: string;
  version?: string;
  code?: string;
}

export function splitCanonical(canonicalUrl?: string): VersionedCanonicalUrl | undefined {
  if (!canonicalUrl) return undefined;

  const codeIndex = canonicalUrl.indexOf('#');
  let code: string|undefined = undefined;
  if (codeIndex !== -1){
    code = canonicalUrl.substring(codeIndex + 1)
    canonicalUrl = canonicalUrl.substring(0, codeIndex);
  }

  const index = canonicalUrl.indexOf('|');
  if (index === -1) return { canonicalUrl: canonicalUrl, code: code };

  return {
    canonicalUrl: canonicalUrl.substring(0, index),
    version: canonicalUrl.substring(index + 1),
    code: code
  };
}